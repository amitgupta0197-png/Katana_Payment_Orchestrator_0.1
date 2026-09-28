// RubyVault pay-ins (hosted UPI QR checkout) on the merchant's own RubyVault account.
//
// Contract (RubyVault API Documentation v2.00, rubyvault.tech/api/document):
//   signature HMAC-SHA256(canonical, secretKey), hex. canonical = the signed fields as
//             "k=v" joined with "&", in the order the doc lists them (see below).
//   initiate  POST JSON {accountCode, requestId, totalAmount (rupees), clientReference, signature}
//             to /api/checkout/initiate
//             signs accountCode=…&clientReference=…&requestId=…&totalAmount=…
//             -> { status: true, data: { paymentUrl } } | { status: false, message }
//             (live minimum is ₹500: "Minimum checkout amount should be 500")
//   status    POST JSON {accountCode, requestId, signature} to /api/checkout/status
//             signs accountCode=…&requestId=…
//             -> { status: true, data: { requestId, status: "pending" | "success", paymentMode,
//                  bankReference, totalAmount } } | { status: false, message: "Checkout not found." }
//   callback  RubyVault posts the same transaction object to the callback URL given to RubyVault
//             at onboarding (not per order), signed over
//             paymentMode=…&requestId=…&status=…&totalAmount=…&bankReference=… (nulls as "null")
//
// The request takes no return URL: the customer stays on RubyVault's page, and Katana learns the
// outcome from the callback or its own status checks. The doc lists only success and pending;
// RubyVault publishes no sandbox and no payout API.
// Credentials: Account Code = mid.key, Secret Key = mid.salt, optional extra.api_base (required for TEST).

import { createHmac, timingSafeEqual } from "crypto";
import type { GatewayMid } from "@/lib/gateway-creds";
import { paiseFrom, type PayinCall, type PayinConnector, type PayinState } from "@/lib/payin-providers/types";

const DEFAULT_BASE = "https://rubyvault.tech";

const canonical = (pairs: [string, unknown][]) =>
  pairs.map(([k, v]) => `${k}=${v == null ? "null" : String(v)}`).join("&");

export function rubyvaultSign(pairs: [string, unknown][], secret: string): string {
  return createHmac("sha256", secret).update(canonical(pairs)).digest("hex");
}

const CALLBACK_FIELDS = ["paymentMode", "requestId", "status", "totalAmount", "bankReference"];

/** The transaction object of a callback, whether RubyVault wraps it in { data } or not. */
export function rubyvaultTxn(body: any): Record<string, unknown> {
  return body?.data && typeof body.data === "object" ? body.data : (body ?? {});
}

/**
 * A callback's signature against the merchant's secret: true / false, or null when it carries
 * none. The doc's field order isn't alphabetical, so the sorted order is accepted too; hex in
 * either case or base64.
 */
export function rubyvaultCallbackOk(body: any, secret: string): boolean | null {
  const t = rubyvaultTxn(body);
  const got = String(t.signature ?? body?.signature ?? "").trim();
  if (!got) return null;
  const orders = [CALLBACK_FIELDS, [...CALLBACK_FIELDS].sort()];
  return orders.some((keys) => {
    const mac = createHmac("sha256", secret).update(canonical(keys.map((k) => [k, t[k]]))).digest();
    return [mac.toString("hex"), mac.toString("base64")].some((want) => {
      const a = Buffer.from(want.length === 64 ? got.toLowerCase() : got);
      const b = Buffer.from(want);
      return a.length === b.length && timingSafeEqual(a, b);
    });
  });
}

// A TEST account must name a RubyVault test host, so a sandbox payment never reaches production.
function baseOf(mid: GatewayMid): string {
  const b = mid.extra?.api_base || (mid.env === "PROD" ? DEFAULT_BASE : "");
  return b.replace(/\/$/, "");
}

/** Rupees as a JSON number, and as it appears in the canonical string ("500", "12.5"). */
export const rubyvaultAmount = (minor: bigint): number => Number(minor) / 100;

const REF_OK = /^[A-Za-z0-9_-]{1,64}$/;

async function post(url: string, body: unknown, timeoutMs = 15_000): Promise<PayinCall<{ httpStatus: number; body: any }>> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    try { return { ok: true, data: { httpStatus: res.status, body: JSON.parse(text) } }; }
    catch { return { ok: false, error: `RubyVault returned a non-JSON reply (HTTP ${res.status})` }; }
  } catch {
    return { ok: false, error: "RubyVault unreachable" };
  }
}

const msgOf = (b: any, status: number) => String(b?.message || `HTTP ${status}`).slice(0, 200);

// Only words that describe the customer's payment; the doc names none, so these are guesses
// that can only ever close an order RubyVault itself calls failed.
const FAILED = /^(failed|failure|declined|rejected|cancelled|canceled|expired|timeout)$/i;

/** What a RubyVault transaction object says, reduced to what Katana acts on. */
export function rubyvaultPayinState(t: Record<string, any>): PayinState {
  const status = String(t?.status ?? "");
  const final: PayinState["final"] =
    /^success$/i.test(status) ? "SUCCESS"
    : FAILED.test(status) ? "FAILED"
    : null;
  return {
    found: true, final,
    status: status || "UNKNOWN",
    bankRef: t?.bankReference ? String(t.bankReference) : undefined,
    amountMinor: final === "SUCCESS" ? paiseFrom(t?.totalAmount) : undefined,
    mode: t?.paymentMode ? String(t.paymentMode) : undefined,
    error: final === "FAILED" ? status : undefined,
    raw: t,
  };
}

export const rubyvaultPayin: PayinConnector = {
  id: "RUBYVAULT",
  name: "RubyVault",

  async checkout(mid, o) {
    const base = baseOf(mid);
    if (!base) return { ok: false, error: "no RubyVault test URL is set for this merchant's TEST account" };
    if (!REF_OK.test(o.txnid)) return { ok: false, error: "RubyVault needs a txnid of 1-64 letters, digits, _ or -" };
    const totalAmount = rubyvaultAmount(o.amountMinor);
    const body = {
      accountCode: mid.key,
      requestId: o.txnid,
      totalAmount,
      clientReference: o.txnid,
      signature: rubyvaultSign([
        ["accountCode", mid.key], ["clientReference", o.txnid], ["requestId", o.txnid], ["totalAmount", totalAmount],
      ], mid.salt),
    };
    const r = await post(`${base}/api/checkout/initiate`, body, 20_000);
    if (!r.ok) return r;
    const { httpStatus, body: res } = r.data;
    const url = res?.data?.paymentUrl;
    if (res?.status !== true || typeof url !== "string" || !/^https:\/\//i.test(url))
      return { ok: false, error: `RubyVault did not start the checkout: ${msgOf(res, httpStatus)}` };
    return { ok: true, data: { kind: "redirect", url } };
  },

  async status(mid, txnid) {
    const base = baseOf(mid);
    if (!base) return { ok: false, error: "no RubyVault test URL is set for this merchant's TEST account" };
    const body = {
      accountCode: mid.key,
      requestId: txnid,
      signature: rubyvaultSign([["accountCode", mid.key], ["requestId", txnid]], mid.salt),
    };
    const r = await post(`${base}/api/checkout/status`, body);
    if (!r.ok) return r;
    const { httpStatus, body: res } = r.data;
    if (res?.status === false && /not found/i.test(String(res?.message ?? ""))) return { ok: true, data: { found: false } };
    if (res?.status !== true || !res?.data) return { ok: false, error: `RubyVault lookup failed: ${msgOf(res, httpStatus)}` };
    if (res.data.requestId && String(res.data.requestId) !== txnid) return { ok: false, error: `RubyVault answered for ${res.data.requestId}` };
    return { ok: true, data: rubyvaultPayinState(res.data) };
  },
};
