// A SETTLEMENT is not a collection.
//
// Two completely different money movements arrive on the same channel and read almost
// identically to a text parser:
//
//   collection — a customer pays the settlement VPA. New money. This is what the portals
//                count, what a statement bills on, and what a DT lot consumes.
//   settlement — the payment app moves money it already holds into the merchant's bank
//                account. The SAME money, one leg later. Counting it adds nothing to the
//                day's takings; it just states them twice.
//
// Live example (2026-08-17, banker PRVZS23). Four GPay collections on 16 Aug were captured
// with their RRNs and verified. Overnight GPay for Business posted:
//
//   "₹40,006.00 deposited — ₹40,006.00 for transactions settled to your bank account"
//
// TxnParser matches "deposited", so the phone forwarded it as a credit. Nothing downstream
// could see it as old money: a settlement carries no RRN (so the RRN dedup can't fire), its
// own wording (so the message hash differs), its own upload (so the nonce differs), it lands
// hours later (so the 20s echo window is long gone), and it states no payment time (so the
// re-notification twin check has no key). It became a fresh "awaiting RRN" row and added
// ₹40,006 of phantom money to gross — and the ₹40,006 is itself the giveaway, being a
// SETTLED BATCH (₹40,000 + ₹6) that no single customer ever paid.
//
// So it is classified here, at ingestion, and stored with txn_type = 'SETTLEMENT': kept for
// audit (settlements are the proof that collected money reached the bank) and excluded from
// every collection feed, total, and statement.

export interface SettlementCandidate {
  raw?: string | null;
  narration?: string | null;
  payer_name?: string | null;
  payer_vpa?: string | null;
  utr?: string | null;
}

/** Value stored in vendor_txn_alerts.txn_type for a settlement leg. */
export const SETTLEMENT_TXN_TYPE = "SETTLEMENT";

// Wording that states the money moved to the merchant's OWN bank account. Deliberately
// phrase-level rather than keyword-level: a bare "settle"/"deposit" also appears in ordinary
// payment copy ("settled instantly", "deposit received"), and one over-broad token here would
// hide real money. Each entry is a whole claim about where the money went.
const SETTLEMENT_PHRASES: RegExp[] = [
  /\bsettled\s+to\s+your\s+(?:bank\s+)?account\b/i,      // GPay Business (observed)
  /\btransactions?\s+settled\b/i,                        // GPay Business (observed)
  /\b(?:deposited|credited|transferred)\s+to\s+your\s+(?:bank|current|savings)\s+account\b/i,
  /\bsettlement\s+(?:of|amount|credited|processed|completed|done|successful|initiated)\b/i,
  /\byour\s+settlement\s+(?:of|for|is|has)\b/i,
  /\bsettlement\s+(?:has\s+been|is)\s+(?:credited|processed|completed)\b/i,
  /\bamount\s+settled\s+(?:to|in)\b/i,
  /\bairtel-settlement\b/i,                              // legacy marker, kept recognised
];

// Extra phrases for a wording we have not seen yet, without a redeploy. Comma-separated
// substrings, matched case-insensitively: TXN_ALERT_SETTLEMENT_PATTERNS="settled to bank,payout of".
function extraPhrases(): string[] {
  return (process.env.TXN_ALERT_SETTLEMENT_PATTERNS ?? "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * True when this CREDIT alert is the payment app settling money to the merchant's bank
 * account rather than a customer paying the merchant.
 *
 * FAILS SAFE. Two conditions must BOTH hold: the text has to make an explicit settlement
 * claim, AND the alert must name nobody — no payer name, no payer VPA, no 12-digit RRN. A
 * settlement has no counterparty and no UPI reference because no UPI transaction happened;
 * a collection has at least one of the three. When settlement wording somehow arrives
 * alongside a named payer we keep it as a collection: a visible duplicate is a nuisance,
 * whereas hiding a real payment under-reports someone's money.
 */
export function isSettlementCredit(a: SettlementCandidate): boolean {
  const text = `${a.raw ?? ""} ${a.narration ?? ""}`.trim();
  if (!text) return false;

  const claimed =
    SETTLEMENT_PHRASES.some((re) => re.test(text)) ||
    extraPhrases().some((p) => text.toLowerCase().includes(p));
  if (!claimed) return false;

  if (a.payer_name?.trim()) return false;
  if (a.payer_vpa?.trim()) return false;
  if (a.utr && /^\d{12}$/.test(a.utr.trim())) return false;

  return true;
}

// ── Shared SQL predicates ─────────────────────────────────────────────────────────────
//
// Every screen that counts collected money must apply the SAME exclusions, or one portal
// reports a number another one contradicts. They live here as one string each so a new
// reader cannot be written that quietly re-includes settlements.
//
// The raw-text clause is a SAFETY NET, not the mechanism: txn_type is what ingestion sets
// and migration 0017 backfills. It keeps an environment that has not yet run 0017 (or a row
// written by an older build) out of the totals regardless.
const LEGACY_SETTLEMENT_RAW =
  `(COALESCE(raw,'') ILIKE '%settled to your bank%' OR COALESCE(raw,'') ILIKE '%transactions settled%' OR COALESCE(raw,'') ILIKE '%airtel-settlement%')`;

/**
 * Rows that are real collected money: not a second sighting of one payment (DUPLICATE), not
 * a payment that never completed (NOT_COMPLETED), and not a settlement leg. Use in every
 * credit feed, KPI, and statement query.
 *
 * NOT_COMPLETED exists because a screen-read cannot see what the screen does not print.
 * PhonePe's History row states time, payer, amount and UTR — but NOT status, so Pending,
 * Failed and Cancelled payments are indistinguishable from successful ones to the agent and
 * were all recorded as collected money. On 2026-08-24 one branch showed Rs39,966 against a
 * true Completed total of Rs16,241: a 2.4x over-report of money that never arrived.
 *
 * Marking such a row NOT_COMPLETED keeps the evidence (amount, UTR, payer all intact) while
 * removing it from every money total at once. Like DUPLICATE, such a row appears in neither
 * this list nor IS_SETTLEMENT — it is deliberately out of both, because it is not money.
 */
export const IS_COLLECTION =
  `COALESCE(outcome,'') NOT IN ('DUPLICATE','NOT_COMPLETED')
   AND COALESCE(txn_type,'CREDIT') <> '${SETTLEMENT_TXN_TYPE}'
   AND NOT ${LEGACY_SETTLEMENT_RAW}`;

/**
 * The settlement legs themselves — what the "Settled to bank" list shows. Mirrors
 * IS_COLLECTION on txn_type, so every stored credit that IS money appears in one list or
 * the other and none can fall between them.
 *
 * The two deliberate exceptions are the rows IS_COLLECTION rejects on `outcome`: a
 * DUPLICATE and a NOT_COMPLETED row belong to neither list, because neither is money that
 * arrived once. They remain queryable by id and outcome for audit.
 */
export const IS_SETTLEMENT =
  `(COALESCE(txn_type,'') = '${SETTLEMENT_TXN_TYPE}' OR ${LEGACY_SETTLEMENT_RAW})`;
