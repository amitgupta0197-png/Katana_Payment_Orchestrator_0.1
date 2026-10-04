// Reconciliation states of a pay-in, and of the money around it.
//
// PURE (no `pg`): the dashboards import the same words the API uses.
//
// Reconciliation runs inside a channel. A pay-in is compared with the evidence of ITS rail only
// (a bank credit is P2P evidence and never settles an INTENT order, lib/txn-reconcile), and every
// figure is built per channel first; "All" is only ever the sum.
//
//   MATCHED              paid, and evidence Katana did not make up agrees: a UTR stated for it,
//                        or a bank credit matched to it for the same amount
//   AMOUNT_MISMATCH      the reference is identifiable, but the money seen differs from the order
//   STATUS_MISMATCH      the bank shows the money, the order says it was not paid
//   MISSING_EXTERNAL     paid, but no evidence yet
//   MISSING_INTERNAL     money arrived on a banker's UPI ID and no order accounts for it
//   DUPLICATE            the reference, or the payment, is on more than one pay-in
//   SETTLEMENT_MISMATCH  a banker has settled more to a channel than that channel collected
//   MANUAL_REVIEW        held, or a payer's proof is waiting for a person
//
// Two more are not results yet: PENDING (the customer may still pay) and NOT_PAID (failed or
// expired, nothing seen). They are counted so the totals cover every order.
//
// `vendor_payin_orders.rrn` is deliberately NOT evidence: an order confirmed without a reference
// gets a generated one (genRrn), so it is always filled on a paid order and proves nothing.

export const RECON_STATES = [
  "MATCHED", "AMOUNT_MISMATCH", "STATUS_MISMATCH", "MISSING_EXTERNAL", "MISSING_INTERNAL",
  "DUPLICATE", "SETTLEMENT_MISMATCH", "MANUAL_REVIEW", "PENDING", "NOT_PAID",
] as const;
export type ReconState = (typeof RECON_STATES)[number];

/** The states that are about one order (MISSING_INTERNAL is a credit, SETTLEMENT_MISMATCH a banker). */
export const ORDER_RECON_STATES: ReconState[] = RECON_STATES.filter((s) => s !== "MISSING_INTERNAL" && s !== "SETTLEMENT_MISMATCH");

/** The states a person should look at. */
export const RECON_EXCEPTIONS: ReconState[] = [
  "AMOUNT_MISMATCH", "STATUS_MISMATCH", "MISSING_EXTERNAL", "MISSING_INTERNAL", "DUPLICATE", "SETTLEMENT_MISMATCH", "MANUAL_REVIEW",
];

export const RECON_LABEL: Record<ReconState, string> = {
  MATCHED: "Matched",
  AMOUNT_MISMATCH: "Amount differs",
  STATUS_MISMATCH: "Status differs",
  MISSING_EXTERNAL: "Awaiting bank evidence",
  MISSING_INTERNAL: "Received, no order",
  DUPLICATE: "Duplicate",
  SETTLEMENT_MISMATCH: "Settlement differs",
  MANUAL_REVIEW: "Needs review",
  PENDING: "Pending",
  NOT_PAID: "Not paid",
};

export const RECON_HELP: Record<ReconState, string> = {
  MATCHED: "Paid, and the bank evidence agrees: a UTR stated for it, or a bank credit of the same amount matched to it.",
  AMOUNT_MISMATCH: "The payment can be identified, but the amount seen at the bank is not the order amount.",
  STATUS_MISMATCH: "The bank shows the money arrived, but the order is not marked paid.",
  MISSING_EXTERNAL: "Marked paid, but there is no bank reference or matched credit for it yet.",
  MISSING_INTERNAL: "Money arrived on a banker's UPI ID and no order accounts for it.",
  DUPLICATE: "The same bank reference or payment is on more than one order.",
  SETTLEMENT_MISMATCH: "A banker has settled more to this channel than the channel collected.",
  MANUAL_REVIEW: "Held, or the customer's proof of payment is waiting for a person to check.",
  PENDING: "The customer may still pay.",
  NOT_PAID: "Failed or expired, and no money was seen.",
};

export function reconVariant(s: ReconState): "success" | "warning" | "danger" | "info" | "default" {
  if (s === "MATCHED") return "success";
  if (s === "PENDING") return "info";
  if (s === "NOT_PAID") return "default";
  if (s === "MISSING_EXTERNAL" || s === "MANUAL_REVIEW") return "warning";
  return "danger";
}

export function parseReconState(v: string | null | undefined): ReconState | null {
  const s = (v ?? "").toUpperCase();
  return (RECON_STATES as readonly string[]).includes(s) ? (s as ReconState) : null;
}

/**
 * The facts the state is decided from, one row per order. The SQL below computes the same thing
 * in the database; `reconStateOf` is the readable statement of the rule and is what the tests
 * hold the SQL to (tests/integration/channel-accounting).
 */
export interface ReconFacts {
  paid: boolean;
  closed: boolean;          // FAILED or EXPIRED
  amount: number;
  statedUtr: boolean;       // a UTR stated by the gateway, ops or the payer's proof (meta.confirmation.utr)
  credits: number;          // bank credits matched and confirmed to it
  creditAmount: number;
  pointedMismatch: boolean; // a bank credit points at it but was not confirmed: its amount differs
  duplicate: boolean;       // its reference is on another order, or a duplicate credit points at it
  review: boolean;          // held, or a payer's proof is waiting
}

const differs = (a: number, b: number) => Math.abs(a - b) > 0.005;

export function reconStateOf(f: ReconFacts): ReconState {
  if (f.paid) {
    if (f.duplicate || f.credits > 1) return "DUPLICATE";
    if (f.credits > 0 && differs(f.creditAmount, f.amount)) return "AMOUNT_MISMATCH";
    if (f.statedUtr || f.credits > 0) return "MATCHED";
    if (f.pointedMismatch) return "AMOUNT_MISMATCH";
    if (f.review) return "MANUAL_REVIEW";
    return "MISSING_EXTERNAL";
  }
  if (f.credits > 0) return "STATUS_MISMATCH";
  if (f.duplicate) return "DUPLICATE";
  if (f.pointedMismatch || f.review) return "MANUAL_REVIEW";
  return f.closed ? "NOT_PAID" : "PENDING";
}

/**
 * How far apart what was expected and what was observed are, for an order in this state: the
 * difference for an amount mismatch, the money the bank showed for a status mismatch, the whole
 * amount for a paid order with no evidence or a duplicate. Nothing for the rest (a review is not
 * decided yet; pending and not-paid orders expect no money).
 */
export function reconVariance(state: ReconState, amount: number, creditAmount: number): number {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  if (state === "AMOUNT_MISMATCH") return creditAmount > 0 ? r2(Math.abs(creditAmount - amount)) : amount;
  if (state === "STATUS_MISMATCH") return creditAmount > 0 ? r2(creditAmount) : amount;
  if (state === "MISSING_EXTERNAL" || state === "DUPLICATE") return amount;
  return 0;
}

// ── The same rule in SQL ────────────────────────────────────────────────────────────────────────

const PAID = `o.status IN ('SUCCESS','SUCCEEDED')`;

/**
 * FROM-clause joins that bring in the facts for `vendor_payin_orders o`: `cr` (confirmed credits),
 * `pm` (credits pointing at the order unconfirmed), `dc` (duplicate credits), `rd` (its stated
 * reference on another order of the same mode).
 */
export const RECON_JOINS = `
      LEFT JOIN (
        SELECT matched_order_id, COUNT(*)::int AS n, SUM(amount)::float AS amt, MIN(utr) AS utr
          FROM vendor_txn_alerts
         WHERE outcome = 'CONFIRMED' AND matched_order_id IS NOT NULL
         GROUP BY matched_order_id
      ) cr ON cr.matched_order_id = o.id
      LEFT JOIN (
        SELECT DISTINCT matched_order_id FROM vendor_txn_alerts
         WHERE matched_order_id IS NOT NULL AND outcome IN ('UNMATCHED','AMBIGUOUS')
      ) pm ON pm.matched_order_id = o.id
      LEFT JOIN (
        SELECT DISTINCT matched_order_id FROM vendor_txn_alerts
         WHERE matched_order_id IS NOT NULL AND outcome = 'DUPLICATE'
      ) dc ON dc.matched_order_id = o.id
      LEFT JOIN (
        SELECT livemode, meta->'confirmation'->>'utr' AS utr
          FROM vendor_payin_orders
         WHERE vendor = 'KATANA' AND COALESCE(meta->'confirmation'->>'utr','') <> ''
         GROUP BY 1, 2 HAVING COUNT(*) > 1
      ) rd ON rd.utr = o.meta->'confirmation'->>'utr' AND rd.livemode = o.livemode`;

/** The state of `o`, given RECON_JOINS. Mirrors reconStateOf. */
export const RECON_STATE_SQL = `
      CASE
        WHEN ${PAID} AND (dc.matched_order_id IS NOT NULL OR rd.utr IS NOT NULL OR COALESCE(cr.n,0) > 1) THEN 'DUPLICATE'
        WHEN ${PAID} AND cr.n > 0 AND abs(cr.amt - o.amount) > 0.005 THEN 'AMOUNT_MISMATCH'
        WHEN ${PAID} AND (COALESCE(o.meta->'confirmation'->>'utr','') <> '' OR cr.n > 0) THEN 'MATCHED'
        WHEN ${PAID} AND pm.matched_order_id IS NOT NULL THEN 'AMOUNT_MISMATCH'
        WHEN ${PAID} AND (o.meta->>'hold' = 'true' OR o.meta->>'review' = 'PROOF_SUBMITTED') THEN 'MANUAL_REVIEW'
        WHEN ${PAID} THEN 'MISSING_EXTERNAL'
        WHEN cr.n > 0 THEN 'STATUS_MISMATCH'
        WHEN dc.matched_order_id IS NOT NULL OR rd.utr IS NOT NULL THEN 'DUPLICATE'
        WHEN pm.matched_order_id IS NOT NULL OR o.meta->>'hold' = 'true' OR o.meta->>'review' = 'PROOF_SUBMITTED' THEN 'MANUAL_REVIEW'
        WHEN o.status IN ('FAILED','EXPIRED') THEN 'NOT_PAID'
        ELSE 'PENDING'
      END`;

/** Paid, but the merchant's server was never sent the status callback (and it was not skipped on purpose). */
export const CALLBACK_MISSING_SQL = `(${PAID} AND o.meta->'callback'->>'sent_at' IS NULL AND COALESCE(o.meta->'callback'->>'skipped','') = '')`;

/** The variance of `o` in state `recon`, given RECON_JOINS. Mirrors reconVariance. */
export const RECON_VARIANCE_SQL = (recon: string) => `
      CASE ${recon}
        WHEN 'AMOUNT_MISMATCH' THEN CASE WHEN COALESCE(cr.amt,0) > 0 THEN round(abs(cr.amt - o.amount)::numeric, 2)::float ELSE o.amount::float END
        WHEN 'STATUS_MISMATCH' THEN CASE WHEN COALESCE(cr.amt,0) > 0 THEN round(cr.amt::numeric, 2)::float ELSE o.amount::float END
        WHEN 'MISSING_EXTERNAL' THEN o.amount::float
        WHEN 'DUPLICATE' THEN o.amount::float
        ELSE 0
      END`;
