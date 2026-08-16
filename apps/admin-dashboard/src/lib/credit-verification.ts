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
