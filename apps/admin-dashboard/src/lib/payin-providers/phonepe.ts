// PhonePe Payment Gateway pay-ins (PG v2, OAuth).
//
// Contract (developer.phonepe.com, Standard Checkout v2 / PG v2):
//   token     POST {identity}/v1/oauth/token  form: client_id, client_version, client_secret,
//             grant_type=client_credentials -> { access_token, expires_at (unix seconds) }
//             identity: sandbox https://api-preprod.phonepe.com/apis/pg-sandbox,
//                       production https://api.phonepe.com/apis/identity-manager
//   calls     header Authorization: O-Bearer <token>
//             pg: sandbox https://api-preprod.phonepe.com/apis/pg-sandbox, production https://api.phonepe.com/apis/pg
//   hosted    POST {pg}/checkout/v2/pay { merchantOrderId, amount (paise), expireAfter,
//             paymentFlow: { type: "PG_CHECKOUT", merchantUrls: { redirectUrl } } } -> { orderId, state, redirectUrl }
//   intent    POST {pg}/payments/v2/pay { merchantOrderId, amount, expireAfter,
//             paymentFlow: { type: "PG", paymentMode: { type: "UPI_INTENT" } } } -> { orderId, state, intentUrl }
//   status    GET {pg}/checkout/v2/order/:merchantOrderId/status (hosted orders)
//             GET {pg}/payments/v2/order/:merchantOrderId/status (intent orders)
//             -> { state: PENDING | COMPLETED | FAILED, amount, paymentDetails: [{ transactionId, paymentMode, state, rail }] }
//   webhook   dashboard-configured with a username + password; PhonePe sends
//             Authorization: sha256hex("username:password")
//
// Credentials: Client ID = mid.key, Client Secret = mid.salt, Client Version = extra.client_version.

import { createHash, timingSafeEqual } from "crypto";
import type { GatewayMid } from "@/lib/gateway-creds";
import { intentQueryOf, type PayinCall, type PayinConnector, type PayinState } from "@/lib/payin-providers/types";

const identity = (env?: string) => env === "PROD"
  ? "https://api.phonepe.com/apis/identity-manager"
  : "https://api-preprod.phonepe.com/apis/pg-sandbox";
const pg = (env?: string) => env === "PROD"
  ? "https://api.phonepe.com/apis/pg"
  : "https://api-preprod.phonepe.com/apis/pg-sandbox";

const EXPIRE_SECONDS = 1200;
const REF_OK = /^[A-Za-z0-9_-]{1,63}$/;

const tokens = new Map<string, { token: string; expiresAt: number }>();

async function token(mid: GatewayMid, fresh = false): Promise<PayinCall<string>> {
  const k = `${mid.env}:${mid.key}`;
  const cached = tokens.get(k);
  if (!fresh && cached && cached.expiresAt > Date.now()) return { ok: true, data: cached.token };
  try {
    const res = await fetch(`${identity(mid.env)}/v1/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        client_id: mid.key, client_version: mid.extra?.client_version ?? "1",
        client_secret: mid.salt, grant_type: "client_credentials",
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j?.access_token) return { ok: false, error: `PhonePe sign-in failed: ${String(j?.message ?? j?.code ?? "HTTP " + res.status).slice(0, 160)}` };
    // Renew a minute before PhonePe's own expiry.
    const exp = Number(j.expires_at) > 0 ? Number(j.expires_at) * 1000 : Date.now() + 10 * 60_000;
    tokens.set(k, { token: String(j.access_token), expiresAt: exp - 60_000 });
    return { ok: true, data: String(j.access_token) };
  } catch {
    return { ok: false, error: "PhonePe unreachable" };
  }
}

async function call(mid: GatewayMid, path: string, init: { method: "GET" | "POST"; body?: unknown; timeoutMs?: number }): Promise<PayinCall<{ httpStatus: number; body: any }>> {
  for (const fresh of [false, true]) {
    const t = await token(mid, fresh);
    if (!t.ok) return t;
    try {
      const res = await fetch(`${pg(mid.env)}${path}`, {
        method: init.method,
        headers: {
          Authorization: `O-Bearer ${t.data}`, Accept: "application/json",
          ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
      });
      if (res.status === 401 && !fresh) continue;
      const text = await res.text();
      try { return { ok: true, data: { httpStatus: res.status, body: JSON.parse(text) } }; }
      catch { return { ok: false, error: `PhonePe returned a non-JSON reply (HTTP ${res.status})` }; }
    } catch {
      return { ok: false, error: "PhonePe unreachable" };
    }
  }
  return { ok: false, error: "PhonePe refused the credentials" };
}

const errText = (b: any, status: number) => String(b?.message ?? b?.code ?? b?.errorCode ?? `HTTP ${status}`).slice(0, 200);
const notFound = (httpStatus: number, b: any) =>
  httpStatus === 404 || /NOT_FOUND|INVALID_MERCHANT_ORDER|ORDER_NOT_FOUND/i.test(String(b?.code ?? b?.errorCode ?? ""));

function toState(b: any): PayinState {
  const state = String(b?.state ?? "").toUpperCase();
  const details: any[] = Array.isArray(b?.paymentDetails) ? b.paymentDetails : [];
  const done = details.find((d) => String(d?.state).toUpperCase() === "COMPLETED") ?? details[details.length - 1];
  const rail = done?.rail ?? {};
  return {
    found: true,
    final: state === "COMPLETED" ? "SUCCESS" : state === "FAILED" ? "FAILED" : null,
    status: state,
    paymentId: done?.transactionId ? String(done.transactionId) : b?.orderId ? String(b.orderId) : undefined,
    bankRef: rail.utr ?? rail.upiTransactionId ?? rail.serviceTransactionId ?? undefined,
    amountMinor: b?.amount != null ? BigInt(Math.trunc(Number(b.amount))) : undefined,
    mode: done?.paymentMode ? String(done.paymentMode) : undefined,
    error: b?.errorCode ?? done?.errorCode ?? undefined,
    raw: b,
  };
}

export const phonepePayin: PayinConnector = {
  id: "PHONEPE",
  name: "PhonePe",

  async checkout(mid, o) {
    if (!REF_OK.test(o.txnid)) return { ok: false, error: "PhonePe needs a txnid of at most 63 letters, digits, _ or -" };
    const r = await call(mid, "/checkout/v2/pay", {
      method: "POST",
      body: {
        merchantOrderId: o.txnid,
        amount: Number(o.amountMinor),
        expireAfter: EXPIRE_SECONDS,
        metaInfo: { udf1: o.productinfo.slice(0, 250) },
        paymentFlow: { type: "PG_CHECKOUT", message: o.productinfo.slice(0, 250), merchantUrls: { redirectUrl: o.returnUrl } },
      },
    });
    if (!r.ok) return r;
    const { httpStatus, body } = r.data;
    if (httpStatus >= 300 || !body?.redirectUrl) return { ok: false, error: `PhonePe refused the order: ${errText(body, httpStatus)}` };
    return { ok: true, data: { kind: "redirect", url: String(body.redirectUrl) } };
  },

  async upiIntent(mid, o) {
    if (!REF_OK.test(o.txnid)) return { ok: false, error: "PhonePe needs a txnid of at most 63 letters, digits, _ or -" };
    const r = await call(mid, "/payments/v2/pay", {
      method: "POST", timeoutMs: 20_000,
      body: {
        merchantOrderId: o.txnid,
        amount: Number(o.amountMinor),
        expireAfter: EXPIRE_SECONDS,
        metaInfo: { udf1: o.productinfo.slice(0, 250) },
        paymentFlow: { type: "PG", paymentMode: { type: "UPI_INTENT" } },
      },
    });
    if (!r.ok) return r;
    const { httpStatus, body } = r.data;
    const q = intentQueryOf(body?.intentUrl);
    if (httpStatus >= 300 || !q) return { ok: false, error: `PhonePe did not return a UPI intent: ${errText(body, httpStatus)}` };
    return { ok: true, data: { intentQuery: q, paymentId: body?.orderId ? String(body.orderId) : null } };
  },

  async status(mid, txnid) {
    if (!REF_OK.test(txnid)) return { ok: true, data: { found: false } };
    // Hosted and intent orders are looked up under different paths; try both.
    for (const path of [`/checkout/v2/order/${encodeURIComponent(txnid)}/status`, `/payments/v2/order/${encodeURIComponent(txnid)}/status`]) {
      const r = await call(mid, path, { method: "GET" });
      if (!r.ok) return r;
      const { httpStatus, body } = r.data;
      if (httpStatus === 200 && body?.state) return { ok: true, data: toState(body) };
      if (!notFound(httpStatus, body)) return { ok: false, error: `PhonePe lookup failed: ${errText(body, httpStatus)}` };
    }
    return { ok: true, data: { found: false } };
  },
};

export function phonepeWebhookTxnid(body: any): string {
  return String(body?.payload?.merchantOrderId ?? body?.merchantOrderId ?? "");
}

/** PhonePe's webhook Authorization is sha256hex("username:password") as set in its dashboard. */
export function phonepeWebhookAuthOk(mid: GatewayMid, header: string | null): boolean | null {
  const u = mid.extra?.webhook_username, p = mid.extra?.webhook_password;
  if (!u || !p) return null;
  if (!header) return false;
  const want = Buffer.from(createHash("sha256").update(`${u}:${p}`).digest("hex"));
  const got = Buffer.from(header.replace(/^SHA256\s+/i, "").trim().toLowerCase());
  return got.length === want.length && timingSafeEqual(got, want);
}
