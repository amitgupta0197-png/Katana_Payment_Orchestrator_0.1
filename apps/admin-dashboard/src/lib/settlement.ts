// Settlement batches (BRD §10 P6).
//
//   buildBatch(merchantId, periodStart, periodEnd, currency) computes
//   gross / fees / commissions / reserves / net by reading the merchant's
//   journal lines in the period. Returns the totals (in minor units) +
//   inserts a row into settlement_batches.

import { rows } from "@/lib/pg";
import { postJournal } from "@/lib/ledger";
import { createPayout, payoutForBatch } from "@/lib/payout";

export interface BatchTotals {
  gross_minor: bigint;
  fees_minor: bigint;
  commissions_minor: bigint;
  reserves_minor: bigint;
  net_minor: bigint;
  payment_count: number;
}

export async function computeTotals(input: {
  merchantId: string; periodStart: Date; periodEnd: Date; currency: string;
}): Promise<BatchTotals> {
  // Sum journal lines tagged to this merchant via account_code naming.
  //   gross    = debits to ASSETS.PG_FLOAT.* on payment.success (true payin volume)
  //   net      = credits MINUS debits on MERCHANT_PAYABLE.<mid>
  //              (debits include in-period refunds/chargebacks — so a refund
  //               correctly reduces the amount we settle, fixing an overpay bug)
  //   reserves = credits to MERCHANT_RESERVE.<mid>
  //   fees     = credits to MDR_EARNED.*  (platform MDR)
  //   commissions = credits to COMMISSION_PAYABLE.* for this merchant
  const r = await rows<any>("ledger", `
    SELECT
      COALESCE(SUM(CASE WHEN a.code LIKE 'ASSETS.PG_FLOAT.%' AND l.side='D' AND j.journal_type='payment.success' THEN l.amount_minor ELSE 0 END),0)::text AS gross_minor,
      COALESCE(SUM(CASE WHEN a.code = 'LIABILITIES.MERCHANT_PAYABLE.' || $1 AND l.side='C' THEN l.amount_minor ELSE 0 END),0)::text AS payable_credit_minor,
      COALESCE(SUM(CASE WHEN a.code = 'LIABILITIES.MERCHANT_PAYABLE.' || $1 AND l.side='D' THEN l.amount_minor ELSE 0 END),0)::text AS payable_debit_minor,
      COALESCE(SUM(CASE WHEN a.code LIKE 'LIABILITIES.MERCHANT_RESERVE.' || $1 AND l.side='C' THEN l.amount_minor ELSE 0 END),0)::text AS reserves_minor,
      COALESCE(SUM(CASE WHEN a.code LIKE 'INCOME.MDR_EARNED.%' AND l.side='C' AND j.merchant_id=$1 THEN l.amount_minor ELSE 0 END),0)::text AS fees_minor,
      COALESCE(SUM(CASE WHEN a.code LIKE 'LIABILITIES.COMMISSION_PAYABLE.%' AND l.side='C' AND j.merchant_id=$1 THEN l.amount_minor ELSE 0 END),0)::text AS commissions_minor,
      COUNT(DISTINCT j.id) FILTER (WHERE j.journal_type='payment.success' AND j.merchant_id=$1)::int AS payment_count
    FROM journal_entries j
    JOIN ledger_lines l ON l.journal_id = j.id
    JOIN accounts a ON a.id = l.account_id
    WHERE j.tenant_id='tenant-default'
      AND j.posted_at >= $2 AND j.posted_at < $3
      AND j.currency = $4
      AND j.merchant_id = $1
  `, [input.merchantId, input.periodStart.toISOString(), input.periodEnd.toISOString(), input.currency]);

  const x = r[0] ?? {};
  const gross = BigInt(x.gross_minor ?? "0");
  const reserves = BigInt(x.reserves_minor ?? "0");
  const fees = BigInt(x.fees_minor ?? "0");
  const commissions = BigInt(x.commissions_minor ?? "0");
  const net = BigInt(x.payable_credit_minor ?? "0") - BigInt(x.payable_debit_minor ?? "0");
  return {
    gross_minor: gross,
    fees_minor: fees,
    commissions_minor: commissions,
    reserves_minor: reserves,
    net_minor: net,
    payment_count: Number(x.payment_count ?? 0),
  };
}

export interface CreateBatchInput {
  merchantId: string;
  periodStart: Date;
  periodEnd: Date;
  currency: string;
  actorEmail?: string;
}

export interface CreatedBatch {
  batch_id: string; status: string;
  totals: BatchTotals;
  settlement_journal_id: string;
  payout_id: string | null;
}

export async function createBatch(input: CreateBatchInput): Promise<CreatedBatch> {
  const totals = await computeTotals(input);

  // Post a "settlement.batch" journal: move funds from MERCHANT_PAYABLE
  // to a SETTLING_BANK asset, debit/credit balanced.
  let settlementJournalId = "";
  if (totals.net_minor > 0n) {
    const j = await postJournal({
      journal_type: "settlement.batch",
      narration: `Settlement batch for ${input.merchantId} ${input.periodStart.toISOString().slice(0,10)}..${input.periodEnd.toISOString().slice(0,10)}`,
      currency: input.currency,
      merchant_id: input.merchantId,
      ref: { type: "settlement_batch", id: `${input.merchantId}:${input.periodStart.toISOString()}` },
      idempotency_key: `settlement.batch:${input.merchantId}:${input.periodStart.toISOString()}:${input.periodEnd.toISOString()}`,
      lines: [
        { account_code: `LIABILITIES.MERCHANT_PAYABLE.${input.merchantId}`, account_type: "LIABILITY",
          side: "D", amount_minor: totals.net_minor, currency: input.currency },
        { account_code: `ASSETS.SETTLING_BANK.${input.merchantId}`, account_type: "ASSET",
          side: "C", amount_minor: totals.net_minor, currency: input.currency },
      ],
    });
    settlementJournalId = j.journal_id;
  }

  const b = await rows<{ batch_id: string; status: string }>("settlement", `
    INSERT INTO settlement_batches
      (tenant_id, merchant_id, batch_date, period_start, period_end, currency,
       txn_count, gross_amount, fee_amount, reserve_amount, net_amount, status)
    VALUES ('tenant-default', $1, ($3::timestamptz)::date, $2, $3, $4, $5,
            $6, $7, $8, $9::bigint,
            CASE WHEN $9::bigint > 0 THEN 'PENDING' ELSE 'EMPTY' END)
    ON CONFLICT (tenant_id, merchant_id, batch_date, currency) DO UPDATE
      SET period_start=EXCLUDED.period_start, period_end=EXCLUDED.period_end,
          txn_count=EXCLUDED.txn_count,
          gross_amount=EXCLUDED.gross_amount, fee_amount=EXCLUDED.fee_amount,
          reserve_amount=EXCLUDED.reserve_amount, net_amount=EXCLUDED.net_amount,
          status=EXCLUDED.status
    RETURNING id::text AS batch_id, status
  `, [
    input.merchantId, input.periodStart, input.periodEnd, input.currency,
    totals.payment_count,
    totals.gross_minor.toString(), totals.fees_minor.toString(),
    totals.reserves_minor.toString(), totals.net_minor.toString(),
  ]).catch(() => []);

  const batchId = b[0]?.batch_id ?? "";

  // Create the disbursement intent (idempotent per batch). Processing it later
  // (or by the settlement trigger) stamps the UTR and flips the batch to PAID.
  let payoutId: string | null = null;
  if (batchId && totals.net_minor > 0n) {
    payoutId = (await payoutForBatch(batchId)) ?? await createPayout({
      merchantId: input.merchantId, batchId,
      amountMinor: totals.net_minor, currency: input.currency,
    });
  }

  return {
    batch_id: batchId,
    status: b[0]?.status ?? "EMPTY",
    totals,
    settlement_journal_id: settlementJournalId,
    payout_id: payoutId,
  };
}
