// Razorpay pay-ins on the merchant's own Razorpay account.
//
// Contract (razorpay.com/docs/api):
//   auth      HTTP Basic key_id:key_secret (mid.key / mid.salt). Test and live differ by key only.
//   order     POST /v1/orders { amount (paise), currency, receipt (≤40, Katana's txnid), notes }
//   hosted    browser POSTs to https://api.razorpay.com/v1/checkout/embedded with key_id,
//             order_id, callback_url, cancel_url, prefill[...] — Razorpay's hosted checkout page
//   intent    POST /v1/payments/create/upi { amount, currency, order_id, email, contact,
//             method: "upi", upi: { flow: "intent" }, ip, user_agent } -> { razorpay_payment_id, link }
//             (S2S UPI must be enabled on the Razorpay account)
//   status    GET /v1/orders?receipt=<txnid>, then GET /v1/orders/:id/payments
//   webhook   dashboard-configured (events order.paid, payment.failed);
//             X-Razorpay-Signature = hex HMAC-SHA256(raw body, webhook secret)
//
// A payment counts once it is `captured`. `authorized` is still in flight: with automatic
// capture (Razorpay's default) it becomes captured within minutes; with manual capture the
// merchant must capture it in their dashboard before Katana treats it as paid.

import { createHmac, timingSafeEqual } from "crypto";
import type { GatewayMid } from "@/lib/gateway-creds";
import {
  intentQueryOf, type CheckoutStart, type PayinCall, type PayinConnector, type PayinState,
} from "@/lib/payin-providers/types";

const API = "https://api.razorpay.com/v1";

async function call(mid: GatewayMid, path: string, init: { method: "GET" | "POST"; body?: unknown; timeoutMs?: number }): Promise<PayinCall<{ httpStatus: number; body: any }>> {
  try {
    const res = await fetch(`${API}${path}`, {
      method: init.method,
      headers: {
        Authorization: "Basic " + Buffer.from(`${mid.key}:${mid.salt}`).toString("base64"),
        Accept: "application/json",
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
    });
    const text = await res.text();
    try { return { ok: true, data: { httpStatus: res.status, body: JSON.parse(text) } }; }
    catch { return { ok: false, error: `Razorpay returned a non-JSON reply (HTTP ${res.status})` }; }
  } catch {
    return { ok: false, error: "Razorpay unreachable" };
  }
}

const errText = (b: any, status: number) =>
  String(b?.error?.description ?? b?.error?.code ?? `HTTP ${status}`).slice(0, 200);

async function createOrder(mid: GatewayMid, o: { txnid: string; amountMinor: bigint; currency: string; productinfo: string }): Promise<PayinCall<string>> {
  // The receipt is how Katana finds the order again, and Razorpay keeps only 40 characters.
  if (o.txnid.length > 40) return { ok: false, error: "Razorpay needs a txnid of at most 40 characters" };
  const r = await call(mid, "/orders", {
    method: "POST",
    body: {
      amount: Number(o.amountMinor), currency: o.currency, receipt: o.txnid,
      notes: { katana_txnid: o.txnid, product: o.productinfo.slice(0, 250) },
    },
  });
  if (!r.ok) return r;
  const { httpStatus, body } = r.data;
  if (httpStatus >= 200 && httpStatus < 300 && body?.id) return { ok: true, data: String(body.id) };
  return { ok: false, error: `Razorpay refused the order: ${errText(body, httpStatus)}` };
}

export const razorpayPayin: PayinConnector = {
  id: "RAZORPAY",
  name: "Razorpay",

  async checkout(mid, o) {
    const order = await createOrder(mid, o);
    if (!order.ok) return order;
    const fields: Record<string, string> = {
      key_id: mid.key,
      order_id: order.data,
      name: o.productinfo.slice(0, 60) || "Payment",
      description: o.txnid,
      "prefill[name]": o.firstname,
      "prefill[email]": o.email,
      "prefill[contact]": o.phone,
      callback_url: o.returnUrl,
      cancel_url: o.returnUrl,
    };
    const start: CheckoutStart = { kind: "form", url: `${API}/checkout/embedded`, fields };
    return { ok: true, data: start };
  },

  async upiIntent(mid, o, client) {
    const order = await createOrder(mid, o);
    if (!order.ok) return order;
    const r = await call(mid, "/payments/create/upi", {
      method: "POST", timeoutMs: 20_000,
      body: {
        amount: Number(o.amountMinor), currency: o.currency, order_id: order.data,
        email: o.email || "payments@katanapay.co", contact: o.phone,
        method: "upi", upi: { flow: "intent" },
        ip: client.ip, user_agent: client.deviceInfo, referer: o.returnUrl,
        description: o.productinfo.slice(0, 250), notes: { katana_txnid: o.txnid },
      },
    });
    if (!r.ok) return r;
    const { httpStatus, body } = r.data;
    const q = intentQueryOf(body?.link);
    if (httpStatus >= 300 || !q) return { ok: false, error: `Razorpay did not return a UPI intent: ${errText(body, httpStatus)}` };
    return { ok: true, data: { intentQuery: q, paymentId: body?.razorpay_payment_id ? String(body.razorpay_payment_id) : null } };
  },

  async status(mid, txnid) {
    const list = await call(mid, `/orders?${new URLSearchParams({ receipt: txnid.slice(0, 40), count: "10" })}`, { method: "GET" });
    if (!list.ok) return list;
    if (list.data.httpStatus !== 200 || !Array.isArray(list.data.body?.items))
      return { ok: false, error: `Razorpay lookup failed: ${errText(list.data.body, list.data.httpStatus)}` };
    const orders = list.data.body.items.filter((x: any) => String(x?.receipt ?? "") === txnid.slice(0, 40));
    if (!orders.length) return { ok: true, data: { found: false } };

    const payments: any[] = [];
    for (const ord of orders) {
      const p = await call(mid, `/orders/${encodeURIComponent(ord.id)}/payments`, { method: "GET" });
      if (!p.ok) return p;
      if (p.data.httpStatus !== 200 || !Array.isArray(p.data.body?.items))
        return { ok: false, error: `Razorpay lookup failed: ${errText(p.data.body, p.data.httpStatus)}` };
      payments.push(...p.data.body.items);
    }
    const captured = payments.find((x) => x?.status === "captured");
    const pick = captured ?? payments.find((x) => x?.status === "authorized" || x?.status === "created") ?? payments[0];
    const final: PayinState["final"] = captured ? "SUCCESS"
      : payments.length && payments.every((x) => x?.status === "failed") ? "FAILED"
      : null;
    if (!pick) return { ok: true, data: { found: true, final: null, status: String(orders[0].status ?? "created").toUpperCase(), raw: orders[0] } };
    return {
      ok: true,
      data: {
        found: true, final,
        status: String(pick.status ?? "").toUpperCase(),
        paymentId: pick.id ? String(pick.id) : undefined,
        bankRef: pick.acquirer_data?.rrn ?? pick.acquirer_data?.upi_transaction_id ?? pick.acquirer_data?.bank_transaction_id ?? undefined,
        amountMinor: pick.amount != null ? BigInt(Math.trunc(Number(pick.amount))) : undefined,
        mode: pick.method ? String(pick.method) : undefined,
        error: pick.error_description ?? pick.error_reason ?? undefined,
        raw: pick,
      },
    };
  },
};

/** The Katana txnid a Razorpay webhook is about (order receipt or the notes Katana set). */
export function razorpayWebhookTxnid(body: any): string {
  const p = body?.payload ?? {};
  return String(
    p.order?.entity?.receipt
    ?? p.order?.entity?.notes?.katana_txnid
    ?? p.payment?.entity?.notes?.katana_txnid
    ?? "",
  );
}

export function razorpaySignatureOk(secret: string | undefined, rawBody: string, signature: string | null): boolean {
  if (!secret || !signature) return false;
  const want = Buffer.from(createHmac("sha256", secret).update(rawBody).digest("hex"));
  const got = Buffer.from(signature.trim());
  return got.length === want.length && timingSafeEqual(got, want);
}
