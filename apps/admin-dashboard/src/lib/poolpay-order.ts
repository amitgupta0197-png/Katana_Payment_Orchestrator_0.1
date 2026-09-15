// Shared PoolPay pay-in order creation. Used by both the cockpit test endpoint
// and the merchant-signed /api/v1/poolpay/order endpoint so the deeplink/insert
// logic lives in one place. Idempotent on (vendor, merchant, livemode, order_id).

import { randomUUID } from "crypto";
import { rows } from "@/lib/pg";
import { buildUpiQuery, buildDeeplinks, poolpayLive, createOrderRemote, genRrn, POOLPAY_TERMINAL, SANDBOX_PAYEE_VPA, type DeepLinks } from "@/lib/poolpay";
import { resolvePoolPayConfig } from "@/lib/provider-integration";
import { sendPayinCallback } from "@/lib/merchant-callback";
import { assertLiveActivated } from "@/lib/live-activation";
import { getGatewayMid } from "@/lib/gateway-creds";
import { createPayuUpiIntent, PayuIntentError, type PayuIntentClient } from "@/lib/payu-intent";

export interface CreatePoolPayInput {
  orderId: string;
  amount: number;
  currency: string;
  channel?: string;
  customerVpa?: string | null;   // sender / payer UPI VPA
  receiverVpa?: string | null;   // single receiver VPA (legacy / convenience)
  receiverVpas?: string[];       // receiver VPA pool (20-25) for backup failover
  mode?: "QR" | "INTENT";        // QR-based vs non-QR (deeplink) presentation
  customerPhone?: string | null;
  merchantId?: string | null;
  returnUrl?: string | null;     // browser redirect target after payment (per-order)
  notifyUrl?: string | null;     // S2S status-callback target (per-order; overrides merchant default)
  livemode?: boolean;            // false = TEST order (default live); set once, never changes
  client?: PayuIntentClient | null; // paying customer's IP + user-agent — PayU requires them
}

/** Set on meta.gateway when PayU issued the order's UPI intent. */
interface PayuGatewayMeta {
  provider: "PAYU";
  txnid: string;                 // the txnid we sent PayU (also vendor_txn_id)
  payment_id: string | null;
  env: string;
  payee_vpa: string | null;      // PayU's collection VPA from the intent
}

// Build the receiver-VPA pool with per-VPA health. The first READY VPA is active;
// on failure ops/merchant advances to the next so the order can still succeed.
export function buildVpaPool(input: CreatePoolPayInput): { pool: { vpa: string; status: string }[]; active: string | null } {
  const list = (input.receiverVpas?.length ? input.receiverVpas : (input.receiverVpa ? [input.receiverVpa] : []))
    .map((v) => v.trim()).filter(Boolean);
  const pool = list.map((vpa, i) => ({ vpa, status: i === 0 ? "ACTIVE" : "READY" }));
  return { pool, active: pool[0]?.vpa ?? null };
}

export interface CreatePoolPayResult {
  order: any;
  deeplinks: DeepLinks;
  upiIntent: string;
  reused: boolean; // true when an order with this (vendor, order_id) already existed
}

function shortId(prefix: string) {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

// Risk threshold (major units). Orders >= this are held for manual review.
export const HIGH_AMOUNT_HOLD = Number(process.env.HIGH_AMOUNT_HOLD ?? 50000);

export class MerchantBlockedError extends Error {
  constructor(public merchantId: string) { super(`merchant ${merchantId} is blocked`); }
}

export async function createPoolPayOrder(input: CreatePoolPayInput): Promise<CreatePoolPayResult> {
  const orderId = input.orderId;
  const note = `Order ${orderId}`;
  // TEST ORDERS CANNOT MOVE MONEY. They pay the sandbox UPI ID (never a request receiver or
  // the merchant's saved settlement VPA), never call a live gateway, and carry no sub-MID
  // attribution — so a real customer cannot pay one, and none counts toward real volume.
  const livemode = input.livemode !== false;

  // Risk: block-merchant — a blocked merchant cannot create new pay-ins.
  if (input.merchantId) {
    const b = await rows<{ blocked: boolean }>(
      "merchant", `SELECT blocked FROM merchant_payment_config WHERE merchant_code = $1`, [input.merchantId],
    ).catch(() => []);
    if (b[0]?.blocked === true) throw new MerchantBlockedError(input.merchantId);
    // A live order needs live mode activated for this merchant (lib/live-activation). Checked here
    // so every route that creates a pay-in — key-signed or from the dashboard — is covered.
    if (livemode) await assertLiveActivated(input.merchantId);
  }

  // Route through the merchant's ACTIVE sub-MID, if one is set. The sub-MID reuses
  // the parent merchant's API key but carries its own identity, so payin volume is
  // attributable per sub-MID. Best-effort: never block order creation on this.
  let subMidCode: string | null = null;
  if (input.merchantId && livemode) {
    const sm = await rows<{ sub_mid_code: string }>(
      "mid",
      `SELECT sub_mid_code FROM sub_mids WHERE merchant_id = $1 AND active_payin = true LIMIT 1`,
      [input.merchantId],
    ).catch(() => []);
    subMidCode = sm[0]?.sub_mid_code ?? null;
  }

  // Resolve the receiver VPA(s): explicit on the request first, else the merchant's
  // configured settlement VPA. Without this a hosted-checkout order that doesn't pass
  // a receiver would point the QR at the sandbox payee instead of the merchant's bank.
  let receivers = livemode
    ? (input.receiverVpas?.length ? input.receiverVpas : (input.receiverVpa ? [input.receiverVpa] : []))
        .map((v) => v.trim()).filter(Boolean)
    : [];
  const saved = input.merchantId && livemode
    ? (await rows<{ v: string | null; name: string | null; name_vpa: string | null }>(
        "merchant", `SELECT poolpay->>'settlement_vpa' AS v, poolpay->>'payee_name' AS name, poolpay->>'payee_name_vpa' AS name_vpa
                       FROM merchant_payment_config WHERE merchant_code = $1`, [input.merchantId],
      ).catch(() => []))[0]
    : undefined;
  const savedVpa = saved?.v?.trim() || null;
  if (!receivers.length && savedVpa) receivers = [savedVpa];
  const { pool, active } = buildVpaPool({ ...input, receiverVpas: receivers, receiverVpa: null });
  // The saved payee name belongs to the one UPI ID it was entered for (payee_name_vpa, bound by
  // the payment-config API). It is sent only when the order pays exactly that account: a
  // receiver passed on the request, or a settlement VPA changed since, is an account whose
  // registered name we do not know — and a wrong name is itself a decline signal.
  const nameVpa = saved?.name_vpa?.trim().toLowerCase() || null;
  const payeeName = active && nameVpa && active.toLowerCase() === nameVpa
    ? saved?.name?.trim() || null : null;
  const mode = input.mode === "INTENT" ? "INTENT" : "QR";

  // Cascade: resolve the effective PoolPay config for this branch — merchant
  // override > provider integration config > env defaults. A provider configured
  // (and PROD + secret) "auto-integrates" all of its branches: their orders sign
  // and route with the provider's credentials with no per-branch setup.
  const cfg = input.merchantId && livemode ? await resolvePoolPayConfig(input.merchantId).catch(() => null) : null;
  const goLive = livemode && (cfg?.live === true || poolpayLive());

  // PayU: a live order for a merchant with PayU Key + Salt gets its UPI intent from PayU, so the
  // customer pays PayU's collection account on the merchant's MID. A link built locally to the
  // merchant's own UPI ID is exactly what UPI apps decline. PayU then confirms the order
  // (lib/payu-result); the bank-credit matcher leaves these orders alone.
  const payuMid = livemode && !goLive && input.merchantId
    ? await getGatewayMid(input.merchantId).then((m) => (m?.gateway === "PAYU" ? m : null)).catch(() => null)
    : null;
  let gateway: PayuGatewayMeta | null = null;

  // Real PoolPay when the cascade resolves to a live (PROD + secret) config or the
  // global POOLPAY_MODE=live env is set; deterministic sandbox otherwise.
  let payId: string, vendorTxnId: string, deeplinks: DeepLinks, upiIntent: string, status = "PENDING";
  if (goLive) {
    const r = await createOrderRemote({
      orderId, amount: input.amount, currency: input.currency,
      customerVpa: input.customerVpa ?? undefined, customerPhone: input.customerPhone ?? undefined, note,
    }, cfg ? {
      baseUrl: cfg.baseUrl, secret: cfg.secret, payId: cfg.payId,
      clientId: cfg.clientId, apiKey: cfg.apiKey, returnUrl: cfg.returnUrl,
    } : undefined);
    payId = r.payId; vendorTxnId = r.vendorTxnId; deeplinks = r.deeplinks; upiIntent = r.upiIntent; status = r.status || "PENDING";
  } else if (payuMid) {
    // PayU refuses a reused txnid, so a replayed order ref must not reach PayU again.
    const prior = await readExistingOrder(orderId, input.merchantId ?? null, livemode);
    if (prior) return prior;

    vendorTxnId = shortId("kp");   // PayU txnid: unique per MID, at most 25 characters
    const base = (process.env.PUBLIC_BASE_URL ?? "https://katanapay.co").replace(/\/$/, "");
    const r = await createPayuUpiIntent(payuMid, {
      txnid: vendorTxnId, amount: input.amount.toFixed(2), productinfo: note,
      firstname: "Customer", email: "payments@katanapay.co",
      phone: input.customerPhone?.trim() || "9999999999",
      surl: `${base}/api/gateway/payu/return`, furl: `${base}/api/gateway/payu/return`,
    }, input.client ?? { ip: "127.0.0.1", deviceInfo: "Mozilla/5.0" });
    if (!r.ok) throw new PayuIntentError(r.error);

    payId = r.paymentId ?? shortId("pay");
    deeplinks = { upi: r.links.upi, paytm: r.links.paytm, phonepe: r.links.phonepe };
    upiIntent = r.links.upi;
    gateway = {
      provider: "PAYU", txnid: vendorTxnId, payment_id: r.paymentId, env: payuMid.env ?? "TEST",
      payee_vpa: new URLSearchParams(r.intentQuery).get("pa"),
    };
  } else {
    payId = shortId("pay");
    // The vendor txn id carries the routing sub-MID as a prefix so each sub-MID
    // produces a distinct transaction identity (and is greppable per sub-MID).
    vendorTxnId = `${livemode ? "" : "test_"}${subMidCode ? subMidCode.toLowerCase() + "_" : ""}${shortId("ppx")}`;
    const query = buildUpiQuery({ payeeVpa: active || undefined, payeeName, orderId, amount: input.amount, note });
    deeplinks = buildDeeplinks(query);
    upiIntent = deeplinks.upi;
  }
  // Risk: high-amount hold — orders at/above the threshold are held for manual
  // review and are NOT auto-settled by the poller; ops must confirm them.
  const hold = input.amount >= HIGH_AMOUNT_HOLD;
  const meta = {
    deeplinks, upi_intent: upiIntent, qr_payload: upiIntent,
    mode,                                  // QR | INTENT
    // A PayU order is paid to PayU's collection account, not the merchant's UPI ID.
    receiver_vpa: gateway ? gateway.payee_vpa : livemode ? (active ?? input.receiverVpa ?? null) : SANDBOX_PAYEE_VPA,
    vpa_pool: pool,                        // [{ vpa, status }] for backup failover
    sender_vpa: input.customerVpa ?? null,
    sub_mid_code: subMidCode,
    hold,                                  // high-amount → manual review
    hold_reason: hold ? `amount >= ${HIGH_AMOUNT_HOLD}` : null,
    return_url: input.returnUrl ?? null,   // browser redirect after pay
    notify_url: input.notifyUrl ?? null,   // per-order S2S callback target
    // Which integration config drove this order (cascade visibility).
    gateway,                               // PayU txnid + payment id when PayU issued the intent
    integration: !livemode ? { source: "test", env: "SANDBOX", provider_id: null, live: false }
      : gateway ? { source: "payu", env: gateway.env, provider_id: null, live: true } : cfg ? {
      source: cfg.source,                  // merchant | provider | env
      env: cfg.env,                        // SANDBOX | PROD
      provider_id: cfg.providerId,
      live: goLive,
    } : { source: "env", env: goLive ? "PROD" : "SANDBOX", provider_id: null, live: goLive },
  };

  const inserted = await rows<any>("vendorGateway", `
    INSERT INTO vendor_payin_orders
      (tenant_id, vendor, merchant_id, sub_mid_code, pay_id, order_id, amount, currency_code, channel,
       vendor_txn_id, response_code, status, customer_vpa, customer_phone, meta, livemode)
    VALUES ('tenant-default','POOLPAY',$1,$2,$3,$4,$5,$6,$7,$8,'U17',$9,$10,$11,$12::jsonb,$13)
    ON CONFLICT (vendor, COALESCE(merchant_id, ''), livemode, order_id) DO NOTHING
    RETURNING id::text, order_id, pay_id, vendor_txn_id, sub_mid_code, amount, currency_code, channel, status, created_at, livemode
  `, [input.merchantId ?? null, subMidCode, payId, orderId, input.amount, input.currency, input.channel ?? "UPI_INTENT",
      vendorTxnId, status, input.customerVpa ?? null, input.customerPhone ?? null, JSON.stringify(meta), livemode]);

  if (inserted.length) return { order: inserted[0], deeplinks, upiIntent, reused: false };

  const prior = await readExistingOrder(orderId, input.merchantId ?? null, livemode);
  // A conflict guarantees a row on this key, so an empty result means the row was
  // deleted between the two statements. Say so rather than returning `order: undefined`,
  // which surfaces to the caller as an opaque "order create failed".
  if (!prior) throw new Error(`pay-in replay lost: order_id=${orderId} merchant=${input.merchantId ?? "-"}`);
  return prior;
}

// IDEMPOTENT REPLAY — AND IT MUST BE SCOPED TO THE MERCHANT.
//
// The insert conflicts on (vendor, merchant, order_id), so re-read on the SAME key.
// Re-reading by (vendor, order_id) alone is what made a colliding txnid hand one
// merchant another merchant's order — its UUID, its amount and its deeplinks, so the
// payer was sent to the wrong collection VPA (migration 0024). The merchant predicate
// mirrors the index expression exactly, NULL included.
async function readExistingOrder(orderId: string, merchantId: string | null, livemode: boolean): Promise<CreatePoolPayResult | null> {
  const existing = await rows<any>("vendorGateway", `
    SELECT id::text, order_id, pay_id, vendor_txn_id, sub_mid_code, amount, currency_code,
           channel, status, created_at, livemode, meta
      FROM vendor_payin_orders
     WHERE vendor = 'POOLPAY'
       AND order_id = $1
       AND COALESCE(merchant_id, '') = COALESCE($2, '')
       AND livemode = $3        -- a test order must never replay the live order with the same ref
  `, [orderId, merchantId, livemode]);
  const ex = existing[0];
  if (!ex) return null;
  // `meta` carries the receiver VPA, the VPA pool, the sub-MID and confirmation detail.
  // It is needed here for the stored deeplinks, but it is not part of the caller's
  // order shape — strip it so it cannot reach an API response.
  const { meta: exMeta, ...exOrder } = ex as Record<string, unknown> & { meta?: Record<string, unknown> };
  const storedMeta = exMeta ?? {};
  return {
    order: exOrder,
    deeplinks: storedMeta.deeplinks as DeepLinks,
    upiIntent: storedMeta.upi_intent as string,
    reused: true,
  };
}

// ── Payment verification / confirmation ───────────────────────────────────────────
// A PoolPay pay-in stays PENDING until the credit is verified in the receiver /
// settlement account. Two channels feed the SINGLE confirmation core below so they
// can never diverge:
//   • ops manual confirm  — POST /api/vendors/poolpay/order/:id/confirm
//   • gateway webhook      — POST /api/vendors/poolpay/callback (settlement credit)
// A sender screenshot does NOT call this directly: it is self-asserted, low-trust
// evidence, so it only parks the order in PROOF_SUBMITTED (see attachPayinProof)
// and an ops person confirms it here after viewing the proof.

export type PoolPayEvidence = "UTR" | "SCREENSHOT" | "WEBHOOK" | "MANUAL" | "DEVICE" | "EMAIL";

export interface ConfirmPoolPayInput {
  id?: string;                 // vendor_payin_orders.id (uuid) — ops path
  orderRef?: string;           // order_id (our reference) — webhook path
  merchantId?: string | null;  // merchant code that scopes an orderRef lookup
  // The mode the EVIDENCE belongs to. A real bank credit or a live-secret webhook passes true, a
  // simulator or test-secret webhook passes false; the order must be in that mode. Omitted only
  // by human decisions (ops confirm, manual case), which may act on either.
  livemode?: boolean;
  outcome: "SUCCESS" | "FAILED";
  utr?: string | null;         // UTR/RRN from bank / scrape / screenshot / gateway
  note?: string | null;
  evidence: PoolPayEvidence;
  actor: string;               // ops email or "gateway:poolpay"
  settlementStatus?: string | null; // gateway settlement state, e.g. "SETTLED"
}

export interface ConfirmPoolPayResult {
  ok: boolean;
  status: number;              // suggested HTTP status for the caller
  order?: { id: string; order_id: string; status: string; rrn: string };
  error?: string;
  idempotent?: boolean;        // true when a terminal order already matched the outcome
}

// Single source of truth for marking a PoolPay pay-in paid/failed. Enforces the
// final-status lock (idempotent for webhook retries), duplicate-UTR blocking, and
// records who/what/how confirmed it on meta.confirmation. settlementStatus=SETTLED
// additionally stamps meta.settlement so the dashboard can distinguish "paid" from
// "settled to the receiver account".
export async function confirmPoolPayOrder(input: ConfirmPoolPayInput): Promise<ConfirmPoolPayResult> {
  const key = input.id ?? input.orderRef;
  if (!key) return { ok: false, status: 400, error: "id or orderRef required" };
  // An order ref is unique per MERCHANT, not platform-wide (vendorGateway 0024/0025). A lookup
  // by ref is therefore scoped to the merchant when the caller knows it, and REFUSED when the
  // ref belongs to more than one merchant — never resolved to whichever row came back first.
  const expected = typeof input.livemode === "boolean" ? input.livemode : null;
  const cur = input.id
    ? await rows<any>("vendorGateway",
        `SELECT id::text, order_id, status, COALESCE(rrn,'') AS rrn, meta, livemode
           FROM vendor_payin_orders WHERE id = $1::uuid AND vendor = 'POOLPAY'`, [key])
    : await rows<any>("vendorGateway",
        `SELECT id::text, order_id, status, COALESCE(rrn,'') AS rrn, meta, livemode
           FROM vendor_payin_orders
          WHERE order_id = $1 AND vendor = 'POOLPAY'
            AND ($2::text IS NULL OR merchant_id = $2)
            AND ($3::boolean IS NULL OR livemode = $3)
          LIMIT 2`, [key, input.merchantId?.trim() || null, expected]);
  if (!cur.length) return { ok: false, status: 404, error: "not found" };
  if (cur.length > 1)
    return { ok: false, status: 409, error: `order ${key} exists for more than one merchant — include merchant_code` };
  const order = cur[0];

  // EVIDENCE AND ORDER MUST BE IN THE SAME MODE. A real credit can never mark a test order paid,
  // and a simulator or test-secret webhook can never mark a live order paid.
  if (expected !== null && (order.livemode !== false) !== expected)
    return { ok: false, status: 409, error: expected
      ? "a test order cannot be confirmed by live evidence"
      : "a live order cannot be confirmed by test evidence" };

  // Final-status lock. A retried webhook delivering the same terminal outcome is a
  // safe idempotent replay; a conflicting outcome is rejected.
  //
  // EXPIRED is a SOFT terminal — it only means "we stopped waiting". A real, confirmed
  // credit landing on an expired order REVIVES it to SUCCESS (the customer paid, so we
  // honour it rather than stranding the money). SUCCESS/SUCCEEDED/FAILED stay HARD
  // final and never change.
  const reviving = order.status === "EXPIRED" && input.outcome === "SUCCESS";
  if (POOLPAY_TERMINAL.has(order.status) && !reviving) {
    if (order.status === input.outcome)
      return { ok: true, status: 200, idempotent: true, order: { id: order.id, order_id: order.order_id, status: order.status, rrn: order.rrn } };
    return { ok: false, status: 409, error: `order already ${order.status}` };
  }

  // Duplicate-UTR blocking — a UTR/RRN may settle exactly one order OF ITS MODE. Across live
  // orders this stays platform-wide on purpose: a real UPI reference is unique network-wide, so
  // one payment can never settle two merchants' orders. Test orders carry generated references,
  // which must never block a real one.
  if (input.outcome === "SUCCESS" && input.utr?.trim()) {
    const dup = await rows<{ order_id: string }>("vendorGateway",
      `SELECT order_id FROM vendor_payin_orders WHERE rrn = $1 AND id <> $2::uuid AND livemode = $3 LIMIT 1`,
      [input.utr.trim(), order.id, order.livemode !== false]);
    if (dup.length) return { ok: false, status: 409, error: `duplicate UTR — already used by order ${dup[0].order_id}` };
  }

  const rrn = input.outcome === "SUCCESS" ? (input.utr?.trim() || genRrn(order.id)) : null;
  const responseCode = input.outcome === "SUCCESS" ? "00" : "U30";
  const settled = input.outcome === "SUCCESS" && input.settlementStatus?.toUpperCase() === "SETTLED";
  const now = new Date().toISOString();
  const meta = {
    ...(order.meta ?? {}),
    review: input.outcome === "SUCCESS" ? "CONFIRMED" : "REJECTED",
    confirmation: {
      by: input.actor, at: now, evidence: input.evidence,
      utr: input.utr ?? null, note: input.note ?? null,
      settlement_status: input.settlementStatus ?? null,
    },
    ...(settled ? { settlement: { status: "SETTLED", at: now } } : {}),
    ...(reviving ? { revived_from_expired: { at: now, by: input.actor } } : {}),
  };

  const upd = await rows<any>("vendorGateway", `
    UPDATE vendor_payin_orders
       SET status = $2, response_code = $3, rrn = COALESCE($4, rrn), meta = $5::jsonb, updated_at = now()
     WHERE id = $1::uuid
    RETURNING id::text, order_id, status, COALESCE(rrn,'') AS rrn
  `, [order.id, input.outcome, responseCode, rrn, JSON.stringify(meta)]);

  // The order just reached a terminal status — POST the signed status callback to
  // the merchant's server (best-effort; idempotent; retried by the outbox).
  sendPayinCallback(order.id).catch(() => {});

  return { ok: true, status: 200, order: upd[0] };
}

export interface AttachProofInput {
  orderId: string;        // vendor_payin_orders.id (uuid)
  orderRef: string;
  kind?: string;          // SCREENSHOT | RECEIPT | BANK_SLIP
  utr?: string | null;
  filename?: string | null;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  storageRef: string;
  uploadedBy?: string;
}

// Records a sender-uploaded payment proof and parks the order in PROOF_SUBMITTED so
// the poller stops auto-expiring it (see autoResolvePaused) and ops sees it needs
// verification. Does NOT settle the order — confirmPoolPayOrder does that on review.
export async function attachPayinProof(input: AttachProofInput): Promise<{ proof_id: string }> {
  const ins = (await rows<{ id: string }>("vendorGateway", `
    INSERT INTO vendor_payin_proofs
      (order_id, order_ref, kind, utr, filename, content_type, size_bytes, sha256, storage_ref, uploaded_by)
    VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id::text
  `, [input.orderId, input.orderRef, (input.kind ?? "SCREENSHOT").toUpperCase(), input.utr ?? null,
      input.filename ?? null, input.contentType, input.sizeBytes, input.sha256, input.storageRef,
      input.uploadedBy ?? "sender"]))[0];

  // Park for review: PROOF_SUBMITTED pauses auto-resolution; stamp the proof summary
  // on meta so the cockpit/confirm dialog can show it without a join.
  await rows("vendorGateway", `
    UPDATE vendor_payin_orders
       SET meta = COALESCE(meta,'{}'::jsonb) || $2::jsonb, updated_at = now()
     WHERE id = $1::uuid AND status NOT IN ('SUCCESS','SUCCEEDED','FAILED','EXPIRED')
  `, [input.orderId, JSON.stringify({
    review: "PROOF_SUBMITTED",
    proof: { submitted_at: new Date().toISOString(), utr: input.utr ?? null, sha256: input.sha256, filename: input.filename ?? null },
  })]).catch(() => {});

  return { proof_id: ins.id };
}
