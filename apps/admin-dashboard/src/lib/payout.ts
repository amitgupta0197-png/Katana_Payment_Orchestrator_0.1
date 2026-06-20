// Settlement payouts (disbursement to the merchant's bank).
//
// createPayout()  — records the intent to disburse a settled net amount.
// processPayout() — simulates the bank transfer (real bank-rail adapter is
//                   future work), stamps a UTR, and flips the linked settlement
//                   batch to PAID. The ledger cash-out is already posted at batch
//                   creation, so processing is operational only — it posts no
//                   additional journal.

import { rows } from "@/lib/pg";
import { randomBytes } from "crypto";

// INR rail selection by amount (paise). RTGS for >= ₹2,00,000, else IMPS.
function pickRail(amountMinor: bigint, currency: string): string {
  if (currency !== "INR") return "WIRE";
  return amountMinor >= 20_000_000n ? "RTGS" : "IMPS";
}

export async function createPayout(input: {
  merchantId: string; batchId: string | null; amountMinor: bigint; currency: string;
}): Promise<string | null> {
  if (input.amountMinor <= 0n) return null;
  const r = await rows<{ id: string }>("payout", `
    INSERT INTO payouts (merchant_id, settlement_batch_id, amount_minor, currency, status, rail)
    VALUES ($1, $2, $3, $4, 'PENDING', $5)
    RETURNING id::text
  `, [input.merchantId, input.batchId, input.amountMinor.toString(), input.currency,
      pickRail(input.amountMinor, input.currency)]).catch(() => []);
  return r[0]?.id ?? null;
}

export interface ProcessResult { ok: boolean; status: string; utr?: string }

export async function processPayout(payoutId: string): Promise<ProcessResult> {
  const p = (await rows<any>("payout",
    `SELECT id::text, merchant_id, settlement_batch_id::text AS settlement_batch_id,
            amount_minor::text, currency, status, utr
       FROM payouts WHERE id = $1::uuid`, [payoutId]).catch(() => []))[0];
  if (!p) return { ok: false, status: "NOT_FOUND" };
  if (p.status === "PAID") return { ok: true, status: "PAID", utr: p.utr };   // idempotent

  // Simulated bank disbursement. A real bank/payout-rail adapter slots in here.
  const utr = "UTR" + randomBytes(7).toString("hex").toUpperCase();
  await rows("payout", `
    UPDATE payouts SET status='PAID', utr=$1, processed_at=now() WHERE id=$2::uuid
  `, [utr, payoutId]);

  if (p.settlement_batch_id) {
    await rows("settlement", `
      UPDATE settlement_batches
         SET status='PAID', utr=$1, payout_ref=$2, completed_at=now()
       WHERE id=$3::uuid
    `, [utr, payoutId, p.settlement_batch_id]).catch(() => {});
  }
  return { ok: true, status: "PAID", utr };
}

// Find the (latest) payout for a settlement batch — used to disburse a batch.
export async function payoutForBatch(batchId: string): Promise<string | null> {
  const r = await rows<{ id: string }>("payout",
    `SELECT id::text FROM payouts WHERE settlement_batch_id = $1::uuid ORDER BY created_at DESC LIMIT 1`,
    [batchId]).catch(() => []);
  return r[0]?.id ?? null;
}
