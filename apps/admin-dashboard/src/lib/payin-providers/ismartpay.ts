// iSmartPay pay-ins (non-seamless hosted checkout) on the merchant's own iSmartPay account.
//
// Contract (docs.ismartpay.co.in/in/payin):
//   auth      headers `mid` (MID from iSmartPay support) and `key` (API key from the partner panel)
//   create    POST JSON {currency, amount ("10.00"), order_id, email, mobile, name, redirect_url,
//             webhook_url} to /api/create/order
//             -> { status: true, status_code: "CREATED", transaction_id, order_id, payment_url }
//             -> { status: false, status_code: "FAIL", errors }
//             (amount ₹100 – ₹2,00,000)
//   status    POST JSON {id: order_id} to /api/order/status
//             -> { status: true, status_code, order_id, amount (rupees), pay_id, transaction_id }
//             pay_id is filled as soon as the customer starts paying, while the order is still
//             PENDING; it is the UTR only once status_code is SUCCESS.
//             -> { status: false }
//   webhook   the same object, POSTed to the webhook_url sent with the order. Unsigned.
//
// status_code: CREATED, PENDING -> still open; SUCCESS -> paid; FAIL -> not paid. The callback is
// not signed, so it only names the order; the status API decides. The doc publishes no sandbox.
// Credentials: MID = mid.key, API key = mid.salt, optional extra.api_base (required for TEST).

import type { GatewayMid } from "@/lib/gateway-creds";
import { paiseFrom, rupees, type PayinCall, type PayinConnector, type PayinState } from "@/lib/payin-providers/types";

const DEFAULT_BASE = "https://pay.ismartpay.co.in";
const MIN_MINOR = 10_000n;       // ₹100
const MAX_MINOR = 20_000_000n;   // ₹2,00,000

// A TEST account must name an iSmartPay test host, so a sandbox payment never reaches production.
function baseOf(mid: GatewayMid): string {
  const b = mid.extra?.api_base || (mid.env === "PROD" ? DEFAULT_BASE : "");
  return b.replace(/\/$/, "");
}

const REF_OK = /^[A-Za-z0-9_-]{1,64}$/;

async function post(mid: GatewayMid, path: string, body: unknown, timeoutMs = 15_000): Promise<PayinCall<{ httpStatus: number; body: any }>> {
  const base = baseOf(mid);
  if (!base) return { ok: false, error: "no iSmartPay test URL is set for this merchant's TEST account" };
  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { mid: mid.key, key: mid.salt, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    try { return { ok: true, data: { httpStatus: res.status, body: JSON.parse(text) } }; }
    catch { return { ok: false, error: `iSmartPay returned a non-JSON reply (HTTP ${res.status})` }; }
  } catch {
    return { ok: false, error: "iSmartPay unreachable" };
  }
}

const msgOf = (b: any, status: number) =>
  String(b?.errors || b?.message || b?.status_code || `HTTP ${status}`).slice(0, 200);

/**
 * The doc shows the status amount as a bare number without saying whether it is rupees or paise.
 * Take whichever reading equals the order; otherwise the rupee reading, which then fails the
 * amount check and leaves the order open rather than settling it for the wrong amount.
 */
function amountOf(v: unknown, expected?: bigint): bigint | undefined {
  const asRupees = paiseFrom(v);
  if (expected == null || asRupees === expected) return asRupees;
  const n = Number(v);
  if (Number.isInteger(n) && BigInt(n) === expected) return expected;
  return asRupees;
}

/** What an iSmartPay order object says, reduced to what Katana acts on. */
export function ismartpayPayinState(t: Record<string, any>, expected?: bigint): PayinState {
  const status = String(t?.status_code ?? "");
  const final: PayinState["final"] =
    /^success$/i.test(status) ? "SUCCESS"
    : /^(fail|failed|failure)$/i.test(status) ? "FAILED"
    : null;
  return {
    found: true, final,
    status: status || "UNKNOWN",
    paymentId: t?.transaction_id ? String(t.transaction_id) : undefined,
    // pay_id appears on PENDING orders too; it is a bank reference only on a SUCCESS.
    bankRef: final === "SUCCESS" && t?.pay_id ? String(t.pay_id) : undefined,
    amountMinor: final === "SUCCESS" ? amountOf(t?.amount, expected) : undefined,
    error: final === "FAILED" ? String(t?.message || t?.errors || status) : undefined,
    raw: t,
  };
}

export const ismartpayPayin: PayinConnector = {
  id: "ISMARTPAY",
  name: "iSmartPay",

  async checkout(mid, o) {
    if (!REF_OK.test(o.txnid)) return { ok: false, error: "iSmartPay needs a txnid of 1-64 letters, digits, _ or -" };
    if (o.amountMinor < MIN_MINOR || o.amountMinor > MAX_MINOR)
      return { ok: false, error: "iSmartPay takes ₹100 to ₹2,00,000 per payment" };
    const phone = o.phone.replace(/\D/g, "").slice(-10);
    const r = await post(mid, "/api/create/order", {
      currency: o.currency || "INR",
      amount: rupees(o.amountMinor),
      order_id: o.txnid,
      email: o.email,
      mobile: /^[6-9]\d{9}$/.test(phone) ? phone : "9999999999",
      name: (o.firstname || "Customer").slice(0, 60),
      redirect_url: o.returnUrl,
      webhook_url: o.notifyUrl,
    }, 20_000);
    if (!r.ok) return r;
    const { httpStatus, body: res } = r.data;
    const url = res?.payment_url;
    if (res?.status !== true || typeof url !== "string" || !/^https:\/\//i.test(url))
      return { ok: false, error: `iSmartPay did not start the checkout: ${msgOf(res, httpStatus)}` };
    return { ok: true, data: { kind: "redirect", url } };
  },

  async status(mid, txnid, amountMinor) {
    const r = await post(mid, "/api/order/status", { id: txnid });
    if (!r.ok) return r;
    const { httpStatus, body: res } = r.data;
    if (res?.status !== true) {
      // A bare { status: false } is iSmartPay's "no such order"; anything with a code is an error.
      if (!res?.status_code && !res?.errors && httpStatus < 500) return { ok: true, data: { found: false } };
      return { ok: false, error: `iSmartPay lookup failed: ${msgOf(res, httpStatus)}` };
    }
    if (res.order_id && String(res.order_id) !== txnid) return { ok: false, error: `iSmartPay answered for ${res.order_id}` };
    return { ok: true, data: ismartpayPayinState(res, amountMinor) };
  },
};
