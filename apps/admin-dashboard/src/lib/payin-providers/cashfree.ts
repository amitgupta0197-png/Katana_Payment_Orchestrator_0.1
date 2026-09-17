// Cashfree Payment Gateway pay-ins (PG API, x-api-version 2023-08-01).
//
// Contract (cashfree.com/docs/api-reference/payments):
//   hosts     sandbox https://sandbox.cashfree.com/pg, production https://api.cashfree.com/pg
//   auth      x-client-id (App ID, mid.key) / x-client-secret (Secret Key, mid.salt)
//   order     POST /orders { order_id (Katana's txnid), order_amount, order_currency,
//             customer_details, order_meta { return_url, notify_url } }
//             -> { cf_order_id, order_id, order_status, payment_session_id }
//   hosted    Cashfree's JS SDK opens the checkout from payment_session_id (no plain URL)
//   intent    POST /orders/sessions { payment_session_id, payment_method: { upi: { channel: "link" } } }
//             -> { data: { payload: { default: "upi://pay?…", gpay, phonepe, paytm, … } } }
//   status    GET /orders/:order_id  (order_status PAID | ACTIVE | EXPIRED | TERMINATED | …)
//             GET /orders/:order_id/payments  (payment_status, bank_reference, payment_group)
//   webhook   x-webhook-signature = base64 HMAC-SHA256(x-webhook-timestamp + raw body, Secret Key)

import { createHmac, timingSafeEqual } from "crypto";
import type { GatewayMid } from "@/lib/gateway-creds";
import {
  esc, intentQueryOf, paiseFrom, rupees, type PayinCall, type PayinConnector, type PayinOrder, type PayinState,
} from "@/lib/payin-providers/types";

const base = (env?: string) => (env === "PROD" ? "https://api.cashfree.com/pg" : "https://sandbox.cashfree.com/pg");

async function call(mid: GatewayMid, path: string, init: { method: "GET" | "POST"; body?: unknown; timeoutMs?: number }): Promise<PayinCall<{ httpStatus: number; body: any }>> {
  try {
    const res = await fetch(`${base(mid.env)}${path}`, {
      method: init.method,
      headers: {
        "x-client-id": mid.key, "x-client-secret": mid.salt, "x-api-version": "2023-08-01",
        Accept: "application/json",
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
    });
    const text = await res.text();
    try { return { ok: true, data: { httpStatus: res.status, body: JSON.parse(text) } }; }
    catch { return { ok: false, error: `Cashfree returned a non-JSON reply (HTTP ${res.status})` }; }
  } catch {
    return { ok: false, error: "Cashfree unreachable" };
  }
}

const errText = (b: any, status: number) => String(b?.message ?? b?.code ?? `HTTP ${status}`).slice(0, 200);
const REF_OK = /^[A-Za-z0-9_-]{3,45}$/;

// Cashfree wants a 10-digit phone and a customer id of letters, digits, _ and -.
function customer(o: PayinOrder) {
  const phone = o.phone.replace(/\D/g, "").slice(-10);
  const valid = /^[6-9]\d{9}$/.test(phone) ? phone : "9999999999";
  return {
    customer_id: `kt_${valid}`,
    customer_phone: valid,
    customer_email: /.+@.+\..+/.test(o.email) ? o.email : "payments@katanapay.co",
    customer_name: o.firstname.slice(0, 100) || "Customer",
  };
}

/** Create the Cashfree order (or pick up the one already made for this txnid). */
async function session(mid: GatewayMid, o: PayinOrder): Promise<PayinCall<string>> {
  if (!REF_OK.test(o.txnid)) return { ok: false, error: "Cashfree needs a txnid of 3-45 letters, digits, _ or -" };
  const r = await call(mid, "/orders", {
    method: "POST",
    body: {
      order_id: o.txnid,
      order_amount: Number(rupees(o.amountMinor)),
      order_currency: o.currency,
      customer_details: customer(o),
      order_meta: { return_url: o.returnUrl, notify_url: o.notifyUrl },
      order_note: o.productinfo.slice(0, 200),
    },
  });
  if (!r.ok) return r;
  let { httpStatus, body } = r.data;
  if (httpStatus === 409) {
    // Already created (a retry): its session is still usable while the order is ACTIVE.
    const g = await call(mid, `/orders/${encodeURIComponent(o.txnid)}`, { method: "GET" });
    if (!g.ok) return g;
    ({ httpStatus, body } = g.data);
    if (httpStatus === 200 && body?.order_status !== "ACTIVE")
      return { ok: false, error: `Cashfree order ${o.txnid} is already ${body?.order_status}` };
  }
  if (httpStatus >= 200 && httpStatus < 300 && body?.payment_session_id) return { ok: true, data: String(body.payment_session_id) };
  return { ok: false, error: `Cashfree refused the order: ${errText(body, httpStatus)}` };
}

export const cashfreePayin: PayinConnector = {
  id: "CASHFREE",
  name: "Cashfree",

  async checkout(mid, o) {
    const s = await session(mid, o);
    if (!s.ok) return s;
    const mode = mid.env === "PROD" ? "production" : "sandbox";
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Redirecting to Cashfree…</title>
<script src="https://sdk.cashfree.com/js/v3/cashfree.js"></script></head>
<body><p style="font-family:sans-serif">Taking you to Cashfree to pay…</p>
<script>
  Cashfree({ mode: ${JSON.stringify(mode)} }).checkout({ paymentSessionId: ${JSON.stringify(s.data)}, redirectTarget: "_self" });
</script>
<noscript>JavaScript is needed to open the Cashfree checkout. <a href="${esc(o.returnUrl)}">Back</a></noscript>
</body></html>`;
    return { ok: true, data: { kind: "html", html } };
  },

  async upiIntent(mid, o) {
    const s = await session(mid, o);
    if (!s.ok) return s;
    const r = await call(mid, "/orders/sessions", {
      method: "POST", timeoutMs: 20_000,
      body: { payment_session_id: s.data, payment_method: { upi: { channel: "link" } } },
    });
    if (!r.ok) return r;
    const { httpStatus, body } = r.data;
    const payload = body?.data?.payload ?? {};
    const q = intentQueryOf(payload.default ?? payload.bhim ?? Object.values(payload)[0]);
    if (httpStatus >= 300 || !q) return { ok: false, error: `Cashfree did not return a UPI intent: ${errText(body, httpStatus)}` };
    return { ok: true, data: { intentQuery: q, paymentId: body?.cf_payment_id != null ? String(body.cf_payment_id) : null } };
  },

  async status(mid, txnid) {
    if (!REF_OK.test(txnid)) return { ok: true, data: { found: false } };
    const r = await call(mid, `/orders/${encodeURIComponent(txnid)}`, { method: "GET" });
    if (!r.ok) return r;
    const { httpStatus, body } = r.data;
    if (httpStatus === 404) return { ok: true, data: { found: false } };
    if (httpStatus !== 200 || String(body?.order_id ?? "") !== txnid)
      return { ok: false, error: `Cashfree lookup failed: ${errText(body, httpStatus)}` };

    const orderStatus = String(body.order_status ?? "").toUpperCase();
    const p = await call(mid, `/orders/${encodeURIComponent(txnid)}/payments`, { method: "GET" });
    const payments: any[] = p.ok && p.data.httpStatus === 200 && Array.isArray(p.data.body) ? p.data.body : [];
    const paid = payments.find((x) => String(x?.payment_status).toUpperCase() === "SUCCESS");
    const pick = paid ?? payments[0];

    // PAID is Cashfree's settled answer; a SUCCESS payment on a not-yet-PAID order is the same
    // payment seen a moment earlier. EXPIRED / TERMINATED orders can no longer be paid.
    const final: PayinState["final"] = orderStatus === "PAID" || paid ? "SUCCESS"
      : orderStatus === "EXPIRED" || orderStatus === "TERMINATED" ? "FAILED"
      : null;
    return {
      ok: true,
      data: {
        found: true, final, status: orderStatus,
        paymentId: pick?.cf_payment_id != null ? String(pick.cf_payment_id) : undefined,
        bankRef: pick?.bank_reference ? String(pick.bank_reference) : undefined,
        amountMinor: paiseFrom(paid?.payment_amount ?? (orderStatus === "PAID" ? body.order_amount : undefined)),
        mode: pick?.payment_group ? String(pick.payment_group) : undefined,
        error: pick?.payment_message ? String(pick.payment_message) : undefined,
        raw: { order: body, payment: pick ?? null },
      },
    };
  },
};

export function cashfreePayinWebhookTxnid(body: any): string {
  return String(body?.data?.order?.order_id ?? body?.orderId ?? body?.order_id ?? "");
}

export function cashfreePayinSignatureOk(secret: string, rawBody: string, headers: Headers): boolean {
  const sig = headers.get("x-webhook-signature");
  const ts = headers.get("x-webhook-timestamp");
  if (!sig || !ts) return false;
  const want = Buffer.from(createHmac("sha256", secret).update(ts + rawBody).digest("base64"));
  const got = Buffer.from(sig.trim());
  return got.length === want.length && timingSafeEqual(got, want);
}
