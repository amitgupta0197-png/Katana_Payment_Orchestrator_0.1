// PoolPay pay-ins (collection) on the merchant's own PoolPay account.
//
// Contract (PoolPay PayIN integration; host confirmed live at gateway.pp-007.com):
//   hash      SHA-256( sorted "KEY=value" pairs joined with "~", then the secret appended ),
//             hex, UPPERCASE. HASH itself is left out.
//   fields    PAY_ID, ORDER_ID, TXNTYPE=SALE, RETURN_URL, CUST_NAME, USER_ID (6–50 chars),
//             CUST_PHONE, CUST_EMAIL, AMOUNT (rupees: "100", "12.50"), CURRENCY_CODE=356,
//             ORDER_DESC, HASH
//   hosted    browser form-POSTs the fields to /api/v1/payin/paymentrequest
//   intent    POST JSON to /api/v1/payin/payment-api -> { OUTPUT: "upi://pay?…", RESPONSE_CODE, TXN_ID }
//   status    POST JSON { PAY_ID, ORDER_ID, AMOUNT, TXNTYPE: "STATUS", CURRENCY_CODE, HASH } to
//             /api/v1/payin/statusenquiry
//             -> RESPONSE_CODE "000" + STATUS "Captured" = paid; "005" = pending;
//                "028" / "Order Id does not exist" = no such order
//   callback  PoolPay posts the result fields (+ HASH) to RETURN_URL; it expects {"STATUS":"TRUE"}.
//
// PoolPay publishes only production; the server IP must be whitelisted by PoolPay.
// Credentials: Pay ID = mid.key, secret = mid.salt, optional extra.api_base (required for TEST).

import { createHash, timingSafeEqual } from "crypto";
import type { GatewayMid } from "@/lib/gateway-creds";
import {
  intentQueryOf, paiseFrom, type PayinCall, type PayinConnector, type PayinOrder, type PayinState,
} from "@/lib/payin-providers/types";

const DEFAULT_BASE = "https://gateway.pp-007.com";

export function poolpayPayinHash(params: Record<string, string>, secret: string): string {
  const base = Object.keys(params).filter((k) => k !== "HASH").sort()
    .map((k) => `${k}=${params[k] ?? ""}`).join("~");
  return createHash("sha256").update(base + secret).digest("hex").toUpperCase();
}

export function poolpayPayinHashOk(params: Record<string, string>, secret: string): boolean {
  const got = Buffer.from(String(params.HASH ?? "").toUpperCase());
  const want = Buffer.from(poolpayPayinHash(params, secret));
  return got.length > 0 && got.length === want.length && timingSafeEqual(got, want);
}

// A TEST account must name PoolPay's UAT host, so a sandbox payment never reaches production.
function baseOf(mid: GatewayMid): string {
  const b = mid.extra?.api_base || (mid.env === "PROD" ? DEFAULT_BASE : "");
  return b.replace(/\/$/, "");
}

/** Rupees as PoolPay writes them: "100" for whole rupees, "12.50" otherwise. */
export function poolpayPayinAmount(minor: bigint): string {
  return minor % 100n === 0n ? String(minor / 100n) : `${minor / 100n}.${(minor % 100n).toString().padStart(2, "0")}`;
}

const REF_OK = /^[A-Za-z0-9_-]{6,50}$/;

function fields(mid: GatewayMid, o: PayinOrder): Record<string, string> {
  const phone = o.phone.replace(/\D/g, "").slice(-10);
  const f: Record<string, string> = {
    PAY_ID: mid.key,
    ORDER_ID: o.txnid,
    TXNTYPE: "SALE",
    RETURN_URL: o.returnUrl,
    CUST_NAME: o.firstname.slice(0, 100) || "Customer",
    USER_ID: o.txnid,
    CUST_PHONE: /^\d{10}$/.test(phone) ? phone : "9999999999",
    CUST_EMAIL: /.+@.+\..+/.test(o.email) ? o.email : "payments@katanapay.co",
    AMOUNT: poolpayPayinAmount(o.amountMinor),
    CURRENCY_CODE: "356",
    ORDER_DESC: o.productinfo.replace(/[^A-Za-z0-9 #._-]/g, " ").slice(0, 100) || "Payment",
  };
  f.HASH = poolpayPayinHash(f, mid.salt);
  return f;
}

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
    catch { return { ok: false, error: `PoolPay returned a non-JSON reply (HTTP ${res.status})` }; }
  } catch {
    return { ok: false, error: "PoolPay unreachable" };
  }
}

const msgOf = (b: any, status: number) =>
  String([b?.RESPONSE_CODE, b?.RESPONSE_MESSAGE ?? b?.STATUS].filter(Boolean).join(" ") || `HTTP ${status}`).slice(0, 200);

// Only words that describe the customer's payment. "Invalid" / "Error" can describe Katana's
// own request, and must never close an order the customer can still pay.
const FAILED = /^(failed|failure|declined|rejected|cancelled|canceled|timeout|timed out|denied)$/i;

/** What a PoolPay status reply (or callback) says, reduced to what Katana acts on. */
export function poolpayPayinState(b: any): PayinState {
  const code = String(b?.RESPONSE_CODE ?? "");
  const status = String(b?.STATUS ?? "");
  if (code === "028" || /does not exist|not found/i.test(String(b?.RESPONSE_MESSAGE ?? ""))) return { found: false };
  const final: PayinState["final"] =
    code === "000" && /^captured$/i.test(status) ? "SUCCESS"
    : code === "005" ? null
    : FAILED.test(status) ? "FAILED"
    : null;
  return {
    found: true, final,
    status: `${status || "UNKNOWN"}${code ? ` (${code})` : ""}`,
    paymentId: b?.TXN_ID ? String(b.TXN_ID) : b?.PG_REF_NUM ? String(b.PG_REF_NUM) : undefined,
    bankRef: b?.RRN ? String(b.RRN) : undefined,
    amountMinor: final === "SUCCESS" ? paiseFrom(b?.AMOUNT ?? b?.TOTAL_AMOUNT) : undefined,
    mode: b?.PAYMENT_TYPE ? String(b.PAYMENT_TYPE) : undefined,
    error: final === "FAILED" ? String(b?.RESPONSE_MESSAGE ?? status) : undefined,
    raw: b,
  };
}

export const poolpayPayin: PayinConnector = {
  id: "POOLPAY",
  name: "PoolPay",

  async checkout(mid, o) {
    const base = baseOf(mid);
    if (!base) return { ok: false, error: "no PoolPay UAT URL is set for this merchant's TEST account" };
    if (!REF_OK.test(o.txnid)) return { ok: false, error: "PoolPay needs a txnid of 6-50 letters, digits, _ or -" };
    return { ok: true, data: { kind: "form", url: `${base}/api/v1/payin/paymentrequest`, fields: fields(mid, o) } };
  },

  async upiIntent(mid, o) {
    const base = baseOf(mid);
    if (!base) return { ok: false, error: "no PoolPay UAT URL is set for this merchant's TEST account" };
    if (!REF_OK.test(o.txnid)) return { ok: false, error: "PoolPay needs a txnid of 6-50 letters, digits, _ or -" };
    const r = await post(`${base}/api/v1/payin/payment-api`, fields(mid, o), 20_000);
    if (!r.ok) return r;
    const { httpStatus, body } = r.data;
    const q = intentQueryOf(body?.OUTPUT);
    if (!q) return { ok: false, error: `PoolPay did not return a UPI intent: ${msgOf(body, httpStatus)}` };
    return { ok: true, data: { intentQuery: q, paymentId: body?.TXN_ID ? String(body.TXN_ID) : null } };
  },

  async status(mid, txnid, amountMinor) {
    const base = baseOf(mid);
    if (!base) return { ok: false, error: "no PoolPay UAT URL is set for this merchant's TEST account" };
    // AMOUNT is part of the signed enquiry; without it PoolPay can't match the order.
    if (amountMinor == null) return { ok: false, error: "PoolPay status needs the order amount" };
    const f: Record<string, string> = {
      PAY_ID: mid.key, ORDER_ID: txnid, AMOUNT: poolpayPayinAmount(amountMinor),
      TXNTYPE: "STATUS", CURRENCY_CODE: "356",
    };
    f.HASH = poolpayPayinHash(f, mid.salt);
    const r = await post(`${base}/api/v1/payin/statusenquiry`, f);
    if (!r.ok) return r;
    const { httpStatus, body } = r.data;
    if (!body?.RESPONSE_CODE) return { ok: false, error: `PoolPay lookup failed: ${msgOf(body, httpStatus)}` };
    if (body.ORDER_ID && String(body.ORDER_ID) !== txnid) return { ok: false, error: `PoolPay answered for ${body.ORDER_ID}` };
    const s = poolpayPayinState(body);
    // A hash-rejected enquiry says nothing about the order.
    if (s.found && s.final === "FAILED" && /hash/i.test(String(body.RESPONSE_MESSAGE ?? "")))
      return { ok: false, error: `PoolPay lookup failed: ${msgOf(body, httpStatus)}` };
    return { ok: true, data: s };
  },
};
