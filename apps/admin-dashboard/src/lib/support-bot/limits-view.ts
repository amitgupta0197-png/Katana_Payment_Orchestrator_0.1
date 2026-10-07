// What a merchant may send per live payment, in the merchant view (no gateway name, no MID), for
// the support bot's get_limits tool. Pure: the facts are lib/banker-check-store's, read with the
// functions the order path uses.
//
// The order path refuses, in this order: the banker's own limits (lib/payin-limits; the platform's
// where none is set), the payment account's own minimum (lib/pg-catalog minAmount, which the
// gateway itself enforces), and while the account is VERIFYING (lib/gateway-golive) anything over
// the verification cap or past the number of verification payments. So the amount that really
// works is the largest of the minimums up to the smallest of the maximums.

import type { BankerCheckFacts } from "@/lib/banker-check";
import { defaultOrderFlow } from "@/lib/banker-check";

export interface LimitsView {
  min_per_payment_rupees: number;
  /** null: no maximum other than UPI's own. */
  max_per_payment_rupees: number | null;
  daily_limit_rupees: number | null;
  /** The payment account is still being verified: only small verification payments go through. */
  being_verified: boolean;
  verification_payments_left: number | null;
  /** Minimum above maximum: no amount works until the account is verified (staff must set it live). */
  no_amount_works: boolean;
  /** H2H: the order API returns the UPI link for the merchant's own page. REDIRECT: send the customer to pay_url. */
  checkout: "H2H" | "REDIRECT" | null;
  /** Why checkout is what it is. REDIRECT comes from the kind of payment account, never from verification. */
  checkout_note: string | null;
  /** Where each number comes from, in plain words, so the answer can say why. */
  why: string[];
}

const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export function limitsView(f: BankerCheckFacts, verificationUsed: number | null, verifyMaxOrders: number): LimitsView {
  const why: string[] = [];
  // A payment account only bounds the orders it takes: Intent orders, or P2P on a P2P processor account.
  const orderFlow = defaultOrderFlow(f.flow);
  const acct = f.account && f.account.connector && (orderFlow === null || f.account.channel === orderFlow) ? f.account : null;

  let min = f.limits.min ?? 1;
  if (f.limits.min != null && f.limits.min > 1) why.push(`account minimum ${inr(f.limits.min)}`);
  if (acct?.minAmount && acct.minAmount > min) {
    min = acct.minAmount;
    why.push(`the payment account takes ${inr(acct.minAmount)} or more per payment`);
  }

  let max = f.limits.max ?? f.limits.upiMax ?? null;
  if (f.limits.max != null) why.push(`account maximum ${inr(f.limits.max)}`);
  else if (f.limits.upiMax != null) why.push(`UPI allows up to ${inr(f.limits.upiMax)} per payment`);

  const verifying = acct?.golive === "VERIFYING";
  let left: number | null = null;
  if (verifying) {
    max = max == null ? acct!.verifyCap : Math.min(max, acct!.verifyCap);
    left = verificationUsed == null ? null : Math.max(verifyMaxOrders - verificationUsed, 0);
    why.push(`the payment account is still being verified: up to ${inr(acct!.verifyCap)} per payment${left != null ? `, ${left} verification payments left` : ""}`);
  }
  if (f.limits.daily != null) why.push(`daily limit ${inr(f.limits.daily)}`);

  const checkout = acct ? acct.checkout : orderFlow === "P2P" || (!f.account && f.upiId) ? "H2H" : null;
  return {
    min_per_payment_rupees: min,
    max_per_payment_rupees: max,
    daily_limit_rupees: f.limits.daily,
    being_verified: verifying,
    verification_payments_left: left,
    no_amount_works: (max != null && min > max) || (verifying && left === 0),
    checkout,
    checkout_note: checkout === "REDIRECT"
      ? "this payment account only offers a hosted payment page, so orders return pay_url and no UPI link. Being verified or set live does not change this; only Katana connecting a different payment account makes it H2H."
      : checkout === "H2H" ? "orders return the UPI link and QR for the merchant's own page." : null,
    why,
  };
}
