// Dispute lifecycle (BRD §10 P6 P6).
//
//   DISPUTE_OPEN → REPRESENTMENT → ACCEPTED | WON | LOST | EXPIRED
//
// openDispute() posts a balanced "dispute.open" journal that DEBITS the
// merchant's payable balance and CREDITS a dispute-hold liability. Resolution
// reverses the hold either back to the merchant (won) or to the customer
// (lost) via another journal.

import { rows } from "@/lib/pg";
import { postJournal } from "@/lib/ledger";

export type DisputeState =
  | "DISPUTE_OPEN" | "REPRESENTMENT" | "ACCEPTED" | "WON" | "LOST" | "EXPIRED";

const ALLOWED: Record<DisputeState, DisputeState[]> = {
  DISPUTE_OPEN:   ["REPRESENTMENT", "ACCEPTED", "WON", "LOST", "EXPIRED"],
  REPRESENTMENT: ["WON", "LOST", "EXPIRED"],
  ACCEPTED: [], WON: [], LOST: [], EXPIRED: [],
};

export function canTransition(from: DisputeState, to: DisputeState): boolean {
  return ALLOWED[from]?.includes(to) ?? false;
}

export interface OpenDisputeInput {
  txnId: string;
  orderId?: string | null;
  merchantId: string;
  reasonCode: string;
  amountMinor: bigint | string | number;
  currency: string;
  deadline?: Date;
  openedBy?: string | null;
}

export async function openDispute(input: OpenDisputeInput): Promise<{
  dispute_id: string; hold_journal_id: string; status: DisputeState;
}> {
  const amt = BigInt(String(input.amountMinor));
  // Post the hold journal first; on success, write the dispute row.
  const j = await postJournal({
    journal_type: "dispute.open",
    narration: `Dispute hold for ${input.txnId}`,
    currency: input.currency,
    merchant_id: input.merchantId,
    ref: { type: "dispute", id: input.txnId },
    idempotency_key: `dispute.open:${input.txnId}`,
    lines: [
      { account_code: `LIABILITIES.MERCHANT_PAYABLE.${input.merchantId}`, account_type: "LIABILITY",
        side: "D", amount_minor: amt, currency: input.currency },
      { account_code: `LIABILITIES.DISPUTE_HOLD.${input.merchantId}`, account_type: "LIABILITY",
        side: "C", amount_minor: amt, currency: input.currency },
    ],
  });

  const d = await rows<{ dispute_id: string }>("riskVelocity", `
    INSERT INTO disputes
      (txn_id, order_id, merchant_id, reason_code, amount_minor, currency,
       status, deadline_at, hold_journal_id, opened_by)
    VALUES ($1, $2::uuid, $3, $4, $5, $6, 'DISPUTE_OPEN', $7, $8::uuid, $9)
    RETURNING dispute_id::text
  `, [
    input.txnId, input.orderId ?? null, input.merchantId, input.reasonCode,
    amt.toString(), input.currency,
    input.deadline ?? new Date(Date.now() + 14 * 86400 * 1000),
    j.journal_id, input.openedBy ?? null,
  ]);
  return { dispute_id: d[0].dispute_id, hold_journal_id: j.journal_id, status: "DISPUTE_OPEN" };
}

export async function transitionDispute(input: {
  disputeId: string; to: DisputeState; actorEmail?: string | null;
  notes?: string;
}): Promise<{ from: DisputeState; to: DisputeState; resolution_journal_id?: string }> {
  const r = await rows<any>("riskVelocity", `
    SELECT dispute_id::text, status, txn_id, merchant_id,
           amount_minor::text, currency
      FROM disputes WHERE dispute_id=$1::uuid
  `, [input.disputeId]);
  if (!r.length) throw new Error("dispute not found");
  const d = r[0];
  const from = d.status as DisputeState;
  if (!canTransition(from, input.to))
    throw new Error(`cannot transition ${from} → ${input.to}`);

  // Resolution journal — only for terminal monetary outcomes.
  let resolutionJournalId: string | undefined;
  if (input.to === "WON") {
    // Return funds to the merchant.
    const j = await postJournal({
      journal_type: "dispute.won",
      narration: `Dispute won for ${d.txn_id}`,
      currency: d.currency,
      merchant_id: d.merchant_id,
      ref: { type: "dispute", id: d.txn_id },
      idempotency_key: `dispute.won:${input.disputeId}`,
      lines: [
        { account_code: `LIABILITIES.DISPUTE_HOLD.${d.merchant_id}`, account_type: "LIABILITY",
          side: "D", amount_minor: d.amount_minor, currency: d.currency },
        { account_code: `LIABILITIES.MERCHANT_PAYABLE.${d.merchant_id}`, account_type: "LIABILITY",
          side: "C", amount_minor: d.amount_minor, currency: d.currency },
      ],
    });
    resolutionJournalId = j.journal_id;
  } else if (input.to === "LOST" || input.to === "ACCEPTED") {
    // Refund the customer: clear hold + drain the in-transit asset.
    const j = await postJournal({
      journal_type: input.to === "LOST" ? "dispute.lost" : "refund.posted",
      narration: `Dispute resolution ${input.to} for ${d.txn_id}`,
      currency: d.currency,
      merchant_id: d.merchant_id,
      ref: { type: "dispute", id: d.txn_id },
      idempotency_key: `dispute.${input.to.toLowerCase()}:${input.disputeId}`,
      lines: [
        { account_code: `LIABILITIES.DISPUTE_HOLD.${d.merchant_id}`, account_type: "LIABILITY",
          side: "D", amount_minor: d.amount_minor, currency: d.currency },
        { account_code: `ASSETS.PG_FLOAT.RESOLUTION`, account_type: "ASSET",
          side: "C", amount_minor: d.amount_minor, currency: d.currency },
      ],
    });
    resolutionJournalId = j.journal_id;
  }

  await rows("riskVelocity", `
    UPDATE disputes
       SET status=$1,
           resolved_at = CASE WHEN $1 IN ('ACCEPTED','WON','LOST','EXPIRED') THEN now() ELSE resolved_at END,
           resolved_by = $2,
           resolution_journal_id = $3::uuid,
           resolution_notes = $4
     WHERE dispute_id=$5::uuid
  `, [input.to, input.actorEmail ?? null, resolutionJournalId ?? null, input.notes ?? null, input.disputeId]);

  return { from, to: input.to, resolution_journal_id: resolutionJournalId };
}
