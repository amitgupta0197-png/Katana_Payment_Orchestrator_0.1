// Verification state of a captured credit — is this payment proven?
//
// DISTINCT FROM ORDER MATCHING. `vendor_txn_alerts.outcome` answers "did a pending Katana
// ORDER match this credit". A direct VPA collection has no order by definition, so its
// outcome is UNMATCHED forever — which rendered every healthy payment as an amber warning
// and made the column carry no information.
//
// What actually proves a direct collection is the 12-digit RRN: the UPI network's own
// reference, unique per transaction, which exists only because a real transfer happened.
//
// THE SETTLEMENT VPA DELIBERATELY DOES NOT DECIDE THIS. On the dominant capture path the
// payee VPA is not reported by the payment at all — txn-reconcile fills it in from the
// banker's own configured settlement VPA when the alert lacks one — so testing it against
// that same config compares a value to itself and always passes. It is used only in the one
// case where it carries information: an alert that DID state a payee VPA which disagrees
// with every VPA configured for that banker, a genuine misconfiguration worth shouting about.
//
// Shared by the banker portal and the merchant (provider) portal so one payment cannot read
// as healthy on one screen and broken on the other.

export type CreditVerification = "matched" | "verified" | "awaiting" | "vpa_mismatch";

export interface VerifiableCredit {
  outcome: string | null;
  utr: string | null;
  payee_vpa: string | null;
}

/**
 * @param vpas every settlement VPA configured for the banker that owns this credit. Pass an
 *             empty list when the caller is not scoped to one banker — a mismatch cannot be
 *             asserted without knowing whose money it is.
 */
export function verificationOf(r: VerifiableCredit, vpas: string[]): CreditVerification {
  if (r.outcome === "CONFIRMED") return "matched";
  const stated = r.payee_vpa?.trim().toLowerCase();
  const set = new Set(vpas.map((v) => v.trim().toLowerCase()).filter(Boolean));
  if (stated && set.size > 0 && !set.has(stated)) return "vpa_mismatch";
  if (!r.utr || !/^\d{12}$/.test(r.utr)) return "awaiting";
  return "verified";
}

/** Label and badge tone for a verification state. */
export function verificationLabel(v: CreditVerification): string {
  return v === "vpa_mismatch" ? "VPA mismatch" : v === "awaiting" ? "awaiting RRN" : v;
}

export function verificationVariant(v: CreditVerification): "success" | "danger" | "warning" {
  return v === "matched" || v === "verified" ? "success" : v === "vpa_mismatch" ? "danger" : "warning";
}

// ── Proven money vs money still being proved ──────────────────────────────────────────
//
// A credit with no RRN is a CLAIM: the phone saw a notification saying money arrived, and
// nothing yet corroborates it. Usually the RRN lands seconds later and the claim becomes a
// fact — but until it does, adding it to the day's takings states as settled money something
// that is still unproven, and a total that mixes the two cannot be reconciled against the
// bank. So every money total is split: proven money is the headline, the rest is reported
// beside it, and the two are never added together.
//
// PROVEN = a 12-digit UPI RRN (the network's own reference, which exists only because a
// transfer happened), or a CONFIRMED match against a Katana order (proof of a different kind:
// the order and the credit agree on amount, VPA and time). A VPA mismatch is excluded from
// both — it is a flagged problem, counted on its own.

/** True when this is the UPI network's own 12-digit reference. */
export function hasRrn(utr: string | null | undefined): boolean {
  return !!utr && /^\d{12}$/.test(utr.trim());
}

/** True when the credit's money is proven, and so belongs in a collected total. */
export function isProven(v: CreditVerification): boolean {
  return v === "verified" || v === "matched";
}

/**
 * SQL form of the same rule, for aggregate queries that never build a row list (the Telegram
 * report). Deliberately mirrors isProven(): RRN present, or the order matched.
 *
 * COALESCE IS LOAD-BEARING. `utr ~ '…'` evaluates to NULL when utr IS NULL, so `NOT (…)` would
 * be NULL too — and a NULL predicate excludes the row from a FILTER. The unproven bucket is
 * exactly the rows with no reference at all, so without this the "awaiting RRN" figure would
 * silently omit them and report zero while the money sat there (caught in verification against
 * prod: 3 no-RRN credits fell out of both buckets).
 */
export const RRN_PROVEN_SQL = `(COALESCE(utr,'') ~ '^[0-9]{12}$' OR COALESCE(outcome,'') = 'CONFIRMED')`;

/** Sum a list of credits to 2dp, without float dust. */
export function sumAmount(list: { amount?: number | null }[]): number {
  return +list.reduce((a, r) => a + Number(r.amount ?? 0), 0).toFixed(2);
}
