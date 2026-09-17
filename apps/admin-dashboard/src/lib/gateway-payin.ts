// Pay-ins through a merchant's own gateway account for every gateway other than PayU
// (Razorpay, Cashfree, CCAvenue, PhonePe, Paytm). PayU keeps lib/payu-*.
//
//   startGatewayCheckout   hosted checkout for /api/pay redirect=true and test payments
//   issueGatewayIntent     UPI intent (no gateway page) for /api/pay intent=true and test payments
//   checkGatewayPayin      ask the gateway about one order and apply the answer. The webhooks,
//                          the browser returns, the verify sweep and the pay page all end here.
//
// Katana Pay orders (lib/poolpay-order) also take their UPI intent from these connectors; they
// carry meta.gateway.provider = <gateway id>, which keeps the bank-credit matcher away from them.
//
// The gateway's status API is the only thing that settles an order. A SUCCESS whose amount
// doesn't match the order is not applied; it is left pending and recorded for ops.

import { rows } from "@/lib/pg";
import { fromMinor, toMinor } from "@/lib/money";
import type { GatewayMid } from "@/lib/gateway-creds";
import { gatewayName } from "@/lib/pg-catalog";
import { enqueue as enqueueWebhook } from "@/lib/webhook-outbox";
import { capturePaymentDetails } from "@/lib/payment-details";
import { confirmPoolPayOrder } from "@/lib/poolpay-order";
import { gatewayPayinFor, payinConnector } from "@/lib/payin-providers";
import {
  checkoutPage, payinProdEnabled, payinReturnUrl, payinWebhookUrl,
  type PayinClient, type PayinConnector, type PayinState,
} from "@/lib/payin-providers/types";

export { gatewayPayinFor, payinConnector };

/** Why this merchant can't take a real payment through the gateway right now, or null. */
export function gatewayLiveBlocker(mid: GatewayMid, livemode: boolean): string | null {
  const name = gatewayName(mid.gateway);
  if (livemode && mid.env !== "PROD") return `this merchant's ${name} credentials are sandbox (TEST); live orders need live credentials`;
  if (!livemode && mid.env === "PROD") return `this merchant's ${name} credentials are live; a test order can't use them`;
  if (mid.env === "PROD" && !payinProdEnabled(mid.gateway)) return `live ${name} payments are not switched on yet`;
  return null;
}

export class GatewayPayinError extends Error {
  readonly status = 502;
}

const ISSUED = "gateway upi intent issued";

// ── Applying a verified answer ───────────────────────────────────────────────

export interface ApplyResult { applied: boolean; status: "SUCCESS" | "FAILED" | "UNKNOWN"; reason?: string }

async function findGatewayPayin(provider: string, txnid: string) {
  return (await rows<{ id: string; merchant_id: string; amount: string; status: string; meta: any }>("vendorGateway", `
    SELECT id::text, merchant_id, amount::text, status, meta FROM vendor_payin_orders
     WHERE vendor = 'POOLPAY' AND vendor_txn_id = $1 AND meta->'gateway'->>'provider' = $2
     LIMIT 1
  `, [txnid, provider]).catch(() => []))[0] ?? null;
}

/** Apply what the gateway said about `txnid` to the order that owns it, once. */
export async function applyGatewayPayinState(provider: string, txnid: string, s: PayinState, source: string): Promise<ApplyResult> {
  const name = gatewayName(provider);
  if (!s.found) return { applied: false, status: "UNKNOWN", reason: "not_found_at_gateway" };

  const o = (await rows<any>("checkout",
    `SELECT id, merchant_id, status, amount_minor::text FROM checkout_orders WHERE txn_id = $1 LIMIT 1`,
    [txnid]).catch(() => []))[0];

  if (!o) {
    const v = await findGatewayPayin(provider, txnid);
    if (!v) return { applied: false, status: "UNKNOWN", reason: "unknown_txn" };
    if (!s.final) return { applied: false, status: "UNKNOWN", reason: `still ${s.status?.toLowerCase()}` };
    if (s.final === "SUCCESS" && s.amountMinor != null && s.amountMinor !== BigInt(Math.round(Number(v.amount) * 100)))
      return { applied: false, status: "UNKNOWN", reason: `amount mismatch: ${name} ${s.amountMinor}, order ${v.amount}` };
    if (s.final === "FAILED") await markGatewayPayinFinal(provider, txnid, s.status ?? "FAILED");
    const r = await confirmPoolPayOrder({
      id: v.id, livemode: true, outcome: s.final,
      utr: s.bankRef?.trim() || null, evidence: "WEBHOOK", actor: `gateway:${provider.toLowerCase()}`,
      note: `${name} ${source}${s.paymentId ? ` (payment ${s.paymentId})` : ""}`,
    });
    if (!r.ok) return { applied: false, status: s.final, reason: r.error };
    return { applied: !r.idempotent, status: s.final, reason: r.idempotent ? "already_final" : undefined };
  }

  await capturePaymentDetails({
    orderId: o.id, provider, source: "verify_api",
    payload: {
      ...(s.raw ?? {}),
      provider_payment_id: s.paymentId, bank_ref_num: s.bankRef, mode: s.mode,
      status: s.status, error: s.error,
    },
  });
  if (o.status === "SUCCESS" || o.status === "FAILED") return { applied: false, status: o.status, reason: "already_final" };
  if (!s.final) return { applied: false, status: "UNKNOWN", reason: `still ${s.status?.toLowerCase()}` };

  const evidence = { source, provider, gateway_status: s.status, payment_id: s.paymentId ?? null, bank_ref: s.bankRef ?? null };
  if (s.final === "SUCCESS" && s.amountMinor != null && s.amountMinor !== BigInt(o.amount_minor)) {
    await rows("checkout", `
      INSERT INTO order_state_transitions (order_id, from_status, to_status, actor_kind, reason, payload)
      VALUES ($1::uuid, $2, $2, 'gateway', $3, $4::jsonb)
    `, [o.id, o.status, `${name} amount mismatch — not applied`,
        JSON.stringify({ ...evidence, gateway_amount_minor: s.amountMinor.toString(), order_amount_minor: o.amount_minor })]).catch(() => {});
    return { applied: false, status: "UNKNOWN", reason: "amount_mismatch" };
  }

  const moved = await rows<{ id: string }>("checkout",
    `UPDATE checkout_orders SET status=$1 WHERE id=$2::uuid AND status NOT IN ('SUCCESS','FAILED') RETURNING id::text`,
    [s.final, o.id]).catch(() => []);
  if (!moved.length) return { applied: false, status: s.final, reason: "already_final" };
  await rows("checkout", `
    INSERT INTO order_state_transitions (order_id, from_status, to_status, actor_kind, reason, payload)
    VALUES ($1::uuid, $2, $3, 'gateway', $4, $5::jsonb)
  `, [o.id, o.status, s.final, `${name} ${source}: ${s.status?.toLowerCase()}`, JSON.stringify(evidence)]).catch(() => {});
  await enqueueWebhook({
    merchantId: o.merchant_id, orderId: o.id,
    eventType: s.final === "SUCCESS" ? "payment.success" : "payment.failed",
    payload: { txn_id: txnid, provider, status: s.final, payment_id: s.paymentId ?? null, bank_ref_num: s.bankRef ?? null, source },
  }).catch(() => null);
  return { applied: true, status: s.final };
}

// ── Asking the gateway ───────────────────────────────────────────────────────

/** Stamp a Katana Pay gateway order as checked now, unless someone checked it in the last `minIntervalSec`. */
export async function claimGatewayPayinCheck(provider: string, txnid: string, minIntervalSec: number): Promise<boolean> {
  const r = await rows<{ id: string }>("vendorGateway", `
    UPDATE vendor_payin_orders
       SET meta = jsonb_set(meta, '{gateway,checked_at}',
                            to_jsonb(to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
     WHERE vendor = 'POOLPAY' AND vendor_txn_id = $1
       AND meta->'gateway'->>'provider' = $3
       AND status NOT IN ('SUCCESS','SUCCEEDED','FAILED')
       AND COALESCE(meta->'gateway'->>'final', '') = ''
       AND (meta->'gateway'->>'checked_at' IS NULL
            OR (meta->'gateway'->>'checked_at')::timestamptz < now() - make_interval(secs => $2::double precision))
    RETURNING id::text
  `, [txnid, minIntervalSec, provider]).catch(() => []);
  return r.length > 0;
}

/** Remember a gateway's definite failure so an EXPIRED order isn't asked about again. */
export async function markGatewayPayinFinal(provider: string, txnid: string, status: string): Promise<void> {
  await rows("vendorGateway", `
    UPDATE vendor_payin_orders SET meta = jsonb_set(meta, '{gateway,final}', to_jsonb($2::text))
     WHERE vendor = 'POOLPAY' AND vendor_txn_id = $1 AND meta->'gateway'->>'provider' = $3
  `, [txnid, status, provider]).catch(() => {});
}

/**
 * Ask the merchant's gateway about `txnid` and apply the answer. `merchantCode` is who the order
 * belongs to; the check is skipped if their pay-in gateway is no longer `provider`.
 */
export async function checkGatewayPayin(input: {
  provider: string; txnid: string; merchantCode: string; source: string;
  /** Katana Pay orders only: skip if checked within this many seconds. */
  throttleSec?: number;
}): Promise<ApplyResult & { lookupError?: string }> {
  const gw = await gatewayPayinFor(input.merchantCode);
  if (!gw || gw.mid.gateway !== input.provider) return { applied: false, status: "UNKNOWN", reason: "no_gateway_credentials" };
  if (input.throttleSec != null && !(await claimGatewayPayinCheck(input.provider, input.txnid, input.throttleSec)))
    return { applied: false, status: "UNKNOWN", reason: "checked_recently" };
  const s = await gw.connector.status(gw.mid, input.txnid, await orderAmountMinor(input.provider, input.txnid));
  if (!s.ok) return { applied: false, status: "UNKNOWN", reason: "lookup_failed", lookupError: s.error };
  return applyGatewayPayinState(input.provider, input.txnid, s.data, input.source);
}

async function orderAmountMinor(provider: string, txnid: string): Promise<bigint | undefined> {
  const c = (await rows<{ a: string }>("checkout", `SELECT amount_minor::text AS a FROM checkout_orders WHERE txn_id = $1 LIMIT 1`, [txnid]).catch(() => []))[0];
  if (c) return BigInt(c.a);
  const v = await findGatewayPayin(provider, txnid);
  return v ? BigInt(Math.round(Number(v.amount) * 100)) : undefined;
}

/** Resolve the merchant and provider of an order Katana created, by its txnid. */
export async function gatewayOrderOwner(provider: string, txnid: string): Promise<{ merchantCode: string; kind: "checkout" | "payin"; dest: string | null } | null> {
  const c = (await rows<{ merchant_id: string; status: string; client_surl: string | null; client_furl: string | null }>("checkout",
    `SELECT merchant_id, status, client_surl, client_furl FROM checkout_orders WHERE txn_id = $1 LIMIT 1`, [txnid]).catch(() => []))[0];
  if (c) return { merchantCode: c.merchant_id, kind: "checkout", dest: null };
  const v = await findGatewayPayin(provider, txnid);
  if (v) return { merchantCode: v.merchant_id, kind: "payin", dest: typeof v.meta?.return_url === "string" ? v.meta.return_url : null };
  return null;
}

/** Where to send the customer's browser after the gateway, once the order has been checked. */
export async function checkoutReturnDest(txnid: string): Promise<{ dest: string | null; status: string }> {
  const c = (await rows<{ status: string; client_surl: string | null; client_furl: string | null }>("checkout",
    `SELECT status, client_surl, client_furl FROM checkout_orders WHERE txn_id = $1 LIMIT 1`, [txnid]).catch(() => []))[0];
  if (!c) return { dest: null, status: "UNKNOWN" };
  const status = c.status === "SUCCESS" || c.status === "FAILED" ? c.status : "PENDING";
  return { dest: status === "SUCCESS" ? c.client_surl : status === "FAILED" ? c.client_furl : c.client_surl ?? c.client_furl, status };
}

// ── Starting a payment ───────────────────────────────────────────────────────

export interface GatewayOrderInput {
  mid: GatewayMid;
  connector: PayinConnector;
  merchantCode: string;
  livemode: boolean;
  txnid: string;
  amount: string;           // major units, exactly as signed ("100.00")
  currency: string;
  method: string;
  productinfo: string;
  firstname: string;
  email: string;
  phone: string;
  clientSurl?: string | null;
  clientFurl?: string | null;
  client: PayinClient;
  actor: string;
}

async function createCheckoutOrder(input: GatewayOrderInput): Promise<{ id: string } | null> {
  const amountMinor = toMinor(input.amount, input.currency);
  const ins = await rows<{ id: string }>("checkout", `
    INSERT INTO checkout_orders
      (tenant_id, merchant_id, client_ref, txn_id, amount, amount_minor, currency,
       method, status, idempotency_key, customer_email, client_surl, client_furl, livemode)
    VALUES ('tenant-default', $1, $2, $3, $4, $5, $6, $7, 'CREATED', $3, $8, $9, $10, $11)
    ON CONFLICT DO NOTHING
    RETURNING id::text
  `, [input.merchantCode, input.productinfo.slice(0, 120), input.txnid,
      Number(fromMinor(amountMinor, input.currency)), String(amountMinor), input.currency,
      input.method, input.email || null, input.clientSurl ?? null, input.clientFurl ?? null, input.livemode]);
  return ins[0] ?? null;
}

function orderFor(input: GatewayOrderInput) {
  return {
    txnid: input.txnid, amountMinor: BigInt(toMinor(input.amount, input.currency)), currency: input.currency,
    productinfo: input.productinfo, firstname: input.firstname, email: input.email, phone: input.phone,
    returnUrl: payinReturnUrl(input.connector.id, input.txnid), notifyUrl: payinWebhookUrl(input.connector.id),
  };
}

async function failOrder(orderId: string, actor: string, reason: string, error: string) {
  await rows("checkout", `UPDATE checkout_orders SET status = 'FAILED' WHERE id = $1::uuid AND status = 'CREATED'`, [orderId]).catch(() => {});
  await rows("checkout", `
    INSERT INTO order_state_transitions (order_id, from_status, to_status, actor_kind, actor_id, reason, payload)
    VALUES ($1::uuid, 'CREATED', 'FAILED', 'gateway', $2, $3, $4::jsonb)
  `, [orderId, actor, reason, JSON.stringify({ error })]).catch(() => {});
}

/** Create the order and build the page that sends the customer to the gateway. */
export async function startGatewayCheckout(input: GatewayOrderInput): Promise<{ httpStatus: number; html?: string; body?: Record<string, unknown> }> {
  const blocker = gatewayLiveBlocker(input.mid, input.livemode);
  if (blocker) return { httpStatus: 409, body: { error: blocker } };
  const existing = await rows<{ id: string; merchant_id: string; status: string }>("checkout",
    `SELECT id::text, merchant_id, status FROM checkout_orders WHERE idempotency_key = $1 LIMIT 1`, [input.txnid]);
  if (existing.length && (existing[0].merchant_id !== input.merchantCode || existing[0].status !== "CREATED"))
    return { httpStatus: 409, body: { error: "txnid already used" } };
  const orderId = existing[0]?.id ?? (await createCheckoutOrder(input))?.id;
  if (!orderId) return { httpStatus: 409, body: { error: "txnid already used" } };

  const r = await input.connector.checkout(input.mid, orderFor(input), input.client);
  if (!r.ok) {
    await failOrder(orderId, input.actor, `${input.connector.name} checkout refused`, r.error);
    return { httpStatus: 502, body: { error: r.error, order: { id: orderId, txn_id: input.txnid, status: "FAILED" } } };
  }
  return { httpStatus: 200, html: checkoutPage(r.data, input.connector.name) };
}

function links(q: string) {
  return {
    upi: `upi://pay?${q}`, phonepe: `phonepe://upi/pay?${q}`, paytm: `paytm://upi/pay?${q}`,
    gpay: `gpay://upi/pay?${q}`, android: `intent://pay?${q}#Intent;scheme=upi;end`,
  };
}

/** Create the order and get its UPI intent from the gateway. Idempotent on txnid. */
export async function issueGatewayIntent(input: GatewayOrderInput): Promise<{ httpStatus: number; body: Record<string, unknown> }> {
  const { connector } = input;
  if (!connector.upiIntent) return { httpStatus: 400, body: { error: `${connector.name} has no UPI intent; use the hosted checkout (redirect=true)` } };
  const blocker = gatewayLiveBlocker(input.mid, input.livemode);
  if (blocker) return { httpStatus: 409, body: { error: blocker } };

  const body = (orderId: string, status: string, q: string, paymentId: string | null, reused: boolean) => {
    const l = links(q);
    return {
      gateway: connector.id, reused,
      order: { id: orderId, txn_id: input.txnid, status, amount: input.amount, currency: input.currency, livemode: input.livemode },
      gateway_payment_id: paymentId, deeplinks: l, upi_intent: l.upi, qr_payload: l.upi,
    };
  };

  const existing = await rows<{ id: string; merchant_id: string; status: string }>("checkout",
    `SELECT id::text, merchant_id, status FROM checkout_orders WHERE idempotency_key = $1 LIMIT 1`, [input.txnid]);
  if (existing.length) {
    const o = existing[0];
    if (o.merchant_id === input.merchantCode) {
      const prev = await rows<{ payload: any }>("checkout", `
        SELECT payload FROM order_state_transitions WHERE order_id = $1::uuid AND reason = $2 ORDER BY occurred_at DESC LIMIT 1
      `, [o.id, ISSUED]).catch(() => []);
      const q = prev[0]?.payload?.intent;
      if (typeof q === "string" && q) return { httpStatus: 200, body: body(o.id, o.status, q, prev[0].payload.payment_id ?? null, true) };
    }
    return { httpStatus: 409, body: { error: "txnid already used" } };
  }

  const created = await createCheckoutOrder({ ...input, method: "UPI_INTENT" });
  if (!created) return { httpStatus: 409, body: { error: "txnid already used" } };
  const r = await connector.upiIntent(input.mid, orderFor(input), input.client);
  if (!r.ok) {
    await failOrder(created.id, input.actor, `${connector.name} upi intent refused`, r.error);
    return { httpStatus: 502, body: { error: r.error, order: { id: created.id, txn_id: input.txnid, status: "FAILED" } } };
  }
  await rows("checkout", `
    INSERT INTO order_state_transitions (order_id, from_status, to_status, actor_kind, actor_id, reason, payload)
    VALUES ($1::uuid, 'CREATED', 'CREATED', 'gateway', $2, $3, $4::jsonb)
  `, [created.id, input.actor, ISSUED, JSON.stringify({ provider: connector.id, intent: r.data.intentQuery, payment_id: r.data.paymentId })]).catch(() => {});
  return { httpStatus: 201, body: body(created.id, "CREATED", r.data.intentQuery, r.data.paymentId, false) };
}

export { payinProdEnabled };
