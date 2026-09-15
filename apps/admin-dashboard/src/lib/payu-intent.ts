// PayU UPI Intent, server-to-server (S2S).
//
// The hosted redirect (lib/payu.ts) sends the customer's browser to PayU's page. This is
// the other shape: Katana calls PayU itself and gets back the UPI intent for the payment,
// which the merchant turns into "Pay with PhonePe / Google Pay / Paytm" buttons or a QR.
// The customer never sees a PayU page.
//
// Contract (PayU docs — "UPI Intent with S2S Integration"):
//   POST  https://test.payu.in/_payment   (TEST)
//         https://info.payu.in/_payment   (PROD)
//   body  the hosted fields (key, txnid, amount, productinfo, firstname, email, phone, surl,
//         furl, hash) plus pg=UPI, bankcode=INTENT, txn_s2s_flow=4, s2s_client_ip,
//         s2s_device_info. Same request hash as the hosted form.
//   reply JSON; result.intentURIData holds the UPI query string (pa=…&pn=…&tr=…&am=…).
//
// The reply only STARTS the payment. It is confirmed the same way as the hosted flow — the
// PayU webhook, the surl/furl return, or the verify sweep (/api/v1/cron/payu-verify) — and
// with intent the customer usually never comes back to a browser, so the webhook and the
// sweep are what actually confirm it.

import type { GatewayMid } from "@/lib/gateway-creds";
import { payuRequestHash, type PayuOrder } from "@/lib/payu";
import { rows } from "@/lib/pg";
import { toMinor, fromMinor } from "@/lib/money";

const ISSUED = "payu upi intent issued";
const REFUSED = "payu upi intent refused";

export function payuS2sUrl(env?: string): string {
  return (env ?? "TEST").toUpperCase() === "PROD"
    ? "https://info.payu.in/_payment"
    : "https://test.payu.in/_payment";
}

/** PayU refused to issue an intent, so no order was created. Routes answer 502 with the message. */
export class PayuIntentError extends Error {
  readonly status = 502;
}

export interface PayuIntentLinks {
  upi: string;        // generic upi://pay — also the QR payload
  phonepe: string;
  paytm: string;
  gpay: string;
  /** Android: opens the chooser of installed UPI apps. */
  android: string;
}

/** Deep links for every app from PayU's intentURIData (app prefixes per PayU docs). */
export function payuIntentLinks(intentQuery: string): PayuIntentLinks {
  return {
    upi: `upi://pay?${intentQuery}`,
    phonepe: `phonepe://upi/pay?${intentQuery}`,
    paytm: `paytm://upi/pay?${intentQuery}`,
    gpay: `gpay://upi/pay?${intentQuery}`,
    android: `intent://pay?${intentQuery}#Intent;scheme=upi;end`,
  };
}

/** intentURIData arrives as a bare query string, but tolerate a full upi:// URI too. */
export function normaliseIntentQuery(v: unknown): string | null {
  if (typeof v !== "string") return null;
  let s = v.trim();
  if (!s) return null;
  const q = s.indexOf("?");
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    if (q < 0) return null;
    s = s.slice(q + 1);
  }
  // A usable intent must name a payee and an amount.
  const p = new URLSearchParams(s);
  if (!p.get("pa") || !p.get("am")) return null;
  // PayU sends the payee name unencoded ("pn=PayU Test Account"). A raw space breaks the link
  // when it is opened; %20, not '+', because Google Pay prints a '+' literally.
  return s.replace(/ /g, "%20");
}

export interface PayuIntentClient {
  ip: string;          // the paying customer's IP (PayU risk-scores on it)
  deviceInfo: string;  // the customer's user-agent
}

export type PayuIntentResult =
  | { ok: true; intentQuery: string; links: PayuIntentLinks; paymentId: string | null; payuStatus: string | null; raw: Record<string, unknown> }
  | { ok: false; error: string; raw?: Record<string, unknown> };

export function payuIntentFields(mid: GatewayMid, o: PayuOrder, client: PayuIntentClient): Record<string, string> {
  return {
    key: mid.key, txnid: o.txnid, amount: o.amount, productinfo: o.productinfo,
    firstname: o.firstname, email: o.email, phone: o.phone,
    surl: o.surl, furl: o.furl, hash: payuRequestHash(mid, o),
    pg: "UPI", bankcode: "INTENT", txn_s2s_flow: "4",
    s2s_client_ip: client.ip, s2s_device_info: client.deviceInfo,
  };
}

/**
 * Ask PayU for a UPI intent. Never throws: a PayU or network failure comes back as
 * ok=false so the caller can answer the merchant cleanly.
 */
export async function createPayuUpiIntent(
  mid: GatewayMid, o: PayuOrder, client: PayuIntentClient,
): Promise<PayuIntentResult> {
  let res: Response;
  try {
    res = await fetch(payuS2sUrl(mid.env), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(payuIntentFields(mid, o, client)).toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return { ok: false, error: "PayU unreachable" };
  }

  const text = await res.text();
  let j: any;
  try { j = JSON.parse(text); } catch {
    // PayU answers an invalid request (bad hash, S2S not enabled on the MID) with an HTML page.
    return { ok: false, error: `PayU returned a non-JSON reply (HTTP ${res.status}) — check the MID has UPI Intent S2S enabled and the Key + Salt are right` };
  }

  const meta = j?.metaData ?? {};
  const result = j?.result ?? {};
  const intentQuery = normaliseIntentQuery(result.intentURIData ?? j?.intentURIData);
  if (!res.ok || !intentQuery) {
    // PayU's refusals look like { status:"failed", error:"EX087", message:"<b>hash</b> …" } —
    // the message is HTML and can quote the expected hash, so strip tags and cut it short.
    const code = j?.error ?? meta.statusCode ?? null;
    const raw = meta.message ?? j?.message ?? j?.error_Message ?? `HTTP ${res.status}`;
    const msg = String(raw).replace(/<[^>]*>/g, " ").split("#~#")[0].replace(/\s+/g, " ").trim().slice(0, 200);
    return { ok: false, error: `PayU did not return a UPI intent${code ? ` (${code})` : ""}: ${msg}`, raw: j };
  }

  return {
    ok: true,
    intentQuery,
    links: payuIntentLinks(intentQuery),
    paymentId: result.paymentId != null ? String(result.paymentId) : meta.referenceId != null ? String(meta.referenceId) : null,
    payuStatus: meta.txnStatus != null ? String(meta.txnStatus).toLowerCase() : null,
    raw: j,
  };
}

export interface IssueIntentInput {
  mid: GatewayMid;
  merchantCode: string;
  livemode: boolean;
  txnid: string;
  amount: string;          // major units, exactly as signed ("100.00")
  currency: string;
  productinfo: string;
  firstname: string;
  email: string;
  phone: string;
  clientSurl?: string | null;   // merchant's own return URLs, forwarded after PayU's return
  clientFurl?: string | null;
  client: PayuIntentClient;
  actor: string;
}

function intentBody(input: IssueIntentInput, orderId: string, status: string, intentQuery: string, paymentId: string | null, reused: boolean) {
  const links = payuIntentLinks(intentQuery);
  return {
    gateway: "PAYU",
    reused,
    order: { id: orderId, txn_id: input.txnid, status, amount: input.amount, currency: input.currency, livemode: input.livemode },
    payu_payment_id: paymentId,
    deeplinks: links,
    upi_intent: links.upi,
    qr_payload: links.upi,
  };
}

/**
 * Create the checkout order and get its UPI intent from PayU.
 *
 * Idempotent on txnid: PayU refuses a reused txnid, so a merchant retry is answered with the
 * intent already issued for it instead of a second PayU call. The order is left CREATED —
 * the webhook, return or verify sweep moves it to SUCCESS / FAILED like any PayU order.
 */
export async function issuePayuIntent(input: IssueIntentInput): Promise<{ httpStatus: number; body: Record<string, unknown> }> {
  const existing = await rows<{ id: string; merchant_id: string; status: string }>("checkout",
    `SELECT id::text, merchant_id, status FROM checkout_orders WHERE idempotency_key = $1 LIMIT 1`, [input.txnid]);
  if (existing.length) {
    const o = existing[0];
    if (o.merchant_id === input.merchantCode) {
      const prev = await rows<{ payload: any }>("checkout", `
        SELECT payload FROM order_state_transitions
         WHERE order_id = $1::uuid AND reason = $2 ORDER BY occurred_at DESC LIMIT 1
      `, [o.id, ISSUED]).catch(() => []);
      const q = normaliseIntentQuery(prev[0]?.payload?.intent);
      if (q) return { httpStatus: 200, body: intentBody(input, o.id, o.status, q, prev[0].payload.payu_payment_id ?? null, true) };
    }
    return { httpStatus: 409, body: { error: "txnid already used" } };
  }

  const amountMinor = toMinor(input.amount, input.currency);
  const ins = await rows<{ id: string }>("checkout", `
    INSERT INTO checkout_orders
      (tenant_id, merchant_id, client_ref, txn_id, amount, amount_minor, currency,
       method, status, idempotency_key, customer_email, client_surl, client_furl, livemode)
    VALUES ('tenant-default', $1, $2, $3, $4, $5, $6, 'UPI_INTENT', 'CREATED', $3, $7, $8, $9, $10)
    ON CONFLICT DO NOTHING
    RETURNING id::text
  `, [input.merchantCode, input.productinfo.slice(0, 120), input.txnid,
      Number(fromMinor(amountMinor, input.currency)), String(amountMinor), input.currency,
      input.email || null, input.clientSurl ?? null, input.clientFurl ?? null, input.livemode]);
  if (!ins.length) return { httpStatus: 409, body: { error: "txnid already used" } };
  const orderId = ins[0].id;

  const base = (process.env.PUBLIC_BASE_URL ?? "https://katanapay.co").replace(/\/$/, "");
  const ret = `${base}/api/gateway/payu/return`;
  const r = await createPayuUpiIntent(input.mid, {
    txnid: input.txnid, amount: input.amount, productinfo: input.productinfo,
    firstname: input.firstname, email: input.email, phone: input.phone,
    surl: ret, furl: ret,
  }, input.client);

  if (!r.ok) {
    // No intent means the customer has nothing to pay with, so the order cannot succeed.
    // Closing it keeps the verify sweep from asking PayU about it for the next 48 hours.
    await rows("checkout", `UPDATE checkout_orders SET status = 'FAILED' WHERE id = $1::uuid`, [orderId]).catch(() => {});
    await rows("checkout", `
      INSERT INTO order_state_transitions (order_id, from_status, to_status, actor_kind, actor_id, reason, payload)
      VALUES ($1::uuid, 'CREATED', 'FAILED', 'gateway', $2, $3, $4::jsonb)
    `, [orderId, input.actor, REFUSED, JSON.stringify({ source: "s2s_intent", error: r.error, raw: r.raw ?? null })]).catch(() => {});
    return { httpStatus: 502, body: { error: r.error, order: { id: orderId, txn_id: input.txnid, status: "FAILED" } } };
  }

  await rows("checkout", `
    INSERT INTO order_state_transitions (order_id, from_status, to_status, actor_kind, actor_id, reason, payload)
    VALUES ($1::uuid, 'CREATED', 'CREATED', 'gateway', $2, $3, $4::jsonb)
  `, [orderId, input.actor, ISSUED, JSON.stringify({
      source: "s2s_intent", intent: r.intentQuery, payu_payment_id: r.paymentId, payu_status: r.payuStatus,
    })]).catch(() => {});

  return { httpStatus: 201, body: intentBody(input, orderId, "CREATED", r.intentQuery, r.paymentId, false) };
}

/** The paying customer's IP + user-agent: explicit values first, else the request headers. */
export function intentClientFrom(req: Request, explicit?: { ip?: string; deviceInfo?: string }): PayuIntentClient {
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return {
    ip: explicit?.ip || fwd || req.headers.get("x-real-ip") || "127.0.0.1",
    deviceInfo: explicit?.deviceInfo || req.headers.get("user-agent") || "Mozilla/5.0",
  };
}
