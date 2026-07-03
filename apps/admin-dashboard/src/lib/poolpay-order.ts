// Shared PoolPay pay-in order creation. Used by both the cockpit test endpoint
// and the merchant-signed /api/v1/poolpay/order endpoint so the deeplink/insert
// logic lives in one place. Idempotent on (vendor, order_id).

import { randomUUID } from "crypto";
import { rows } from "@/lib/pg";
import { buildUpiQuery, buildDeeplinks, poolpayLive, createOrderRemote, genRrn, POOLPAY_TERMINAL, type DeepLinks } from "@/lib/poolpay";
import { resolvePoolPayConfig } from "@/lib/provider-integration";
import { sendPayinCallback } from "@/lib/merchant-callback";

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

  // Risk: block-merchant — a blocked merchant cannot create new pay-ins.
  if (input.merchantId) {
    const b = await rows<{ blocked: boolean }>(
      "merchant", `SELECT blocked FROM merchant_payment_config WHERE merchant_code = $1`, [input.merchantId],
    ).catch(() => []);
    if (b[0]?.blocked === true) throw new MerchantBlockedError(input.merchantId);
  }

  // Route through the merchant's ACTIVE sub-MID, if one is set. The sub-MID reuses
  // the parent merchant's API key but carries its own identity, so payin volume is
  // attributable per sub-MID. Best-effort: never block order creation on this.
  let subMidCode: string | null = null;
  if (input.merchantId) {
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
  let receivers = (input.receiverVpas?.length ? input.receiverVpas : (input.receiverVpa ? [input.receiverVpa] : []))
    .map((v) => v.trim()).filter(Boolean);
  if (!receivers.length && input.merchantId) {
    const cfg = await rows<{ v: string | null }>(
      "merchant", `SELECT poolpay->>'settlement_vpa' AS v FROM merchant_payment_config WHERE merchant_code = $1`, [input.merchantId],
    ).catch(() => []);
    const v = cfg[0]?.v?.trim();
    if (v) receivers = [v];
  }
  const { pool, active } = buildVpaPool({ ...input, receiverVpas: receivers, receiverVpa: null });
  const mode = input.mode === "INTENT" ? "INTENT" : "QR";

  // Cascade: resolve the effective PoolPay config for this branch — merchant
  // override > provider integration config > env defaults. A provider configured
  // (and PROD + secret) "auto-integrates" all of its branches: their orders sign
  // and route with the provider's credentials with no per-branch setup.
  const cfg = input.merchantId ? await resolvePoolPayConfig(input.merchantId).catch(() => null) : null;
  const goLive = cfg?.live === true || poolpayLive();

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
  } else {
    payId = shortId("pay");
    // The vendor txn id carries the routing sub-MID as a prefix so each sub-MID
    // produces a distinct transaction identity (and is greppable per sub-MID).
    vendorTxnId = `${subMidCode ? subMidCode.toLowerCase() + "_" : ""}${shortId("ppx")}`;
    const query = buildUpiQuery({ payeeVpa: active || undefined, orderId, amount: input.amount, note });
    deeplinks = buildDeeplinks(query);
    upiIntent = deeplinks.upi;
  }
  // Risk: high-amount hold — orders at/above the threshold are held for manual
  // review and are NOT auto-settled by the poller; ops must confirm them.
  const hold = input.amount >= HIGH_AMOUNT_HOLD;
  const meta = {
    deeplinks, upi_intent: upiIntent, qr_payload: upiIntent,
    mode,                                  // QR | INTENT
    receiver_vpa: active ?? input.receiverVpa ?? null,
    vpa_pool: pool,                        // [{ vpa, status }] for backup failover
    sender_vpa: input.customerVpa ?? null,
    sub_mid_code: subMidCode,
    hold,                                  // high-amount → manual review
    hold_reason: hold ? `amount >= ${HIGH_AMOUNT_HOLD}` : null,
    return_url: input.returnUrl ?? null,   // browser redirect after pay
    notify_url: input.notifyUrl ?? null,   // per-order S2S callback target
    // Which integration config drove this order (cascade visibility).
    integration: cfg ? {
      source: cfg.source,                  // merchant | provider | env
      env: cfg.env,                        // SANDBOX | PROD
      provider_id: cfg.providerId,
      live: goLive,
    } : { source: "env", env: goLive ? "PROD" : "SANDBOX", provider_id: null, live: goLive },
  };

  const inserted = await rows<any>("vendorGateway", `
    INSERT INTO vendor_payin_orders
      (tenant_id, vendor, merchant_id, sub_mid_code, pay_id, order_id, amount, currency_code, channel,
       vendor_txn_id, response_code, status, customer_vpa, customer_phone, meta)
    VALUES ('tenant-default','POOLPAY',$1,$2,$3,$4,$5,$6,$7,$8,'U17',$9,$10,$11,$12::jsonb)
    ON CONFLICT (vendor, order_id) DO NOTHING
    RETURNING id::text, order_id, pay_id, vendor_txn_id, sub_mid_code, amount, currency_code, channel, status, created_at
  `, [input.merchantId ?? null, subMidCode, payId, orderId, input.amount, input.currency, input.channel ?? "UPI_INTENT",
      vendorTxnId, status, input.customerVpa ?? null, input.customerPhone ?? null, JSON.stringify(meta)]);

  if (inserted.length) return { order: inserted[0], deeplinks, upiIntent, reused: false };

  // Idempotent replay: the (vendor, order_id) already exists — return it with its
  // stored deeplinks so repeated calls with the same reference are safe.
  const existing = await rows<any>("vendorGateway", `
    SELECT id::text, order_id, pay_id, vendor_txn_id, amount, currency_code, channel, status, created_at, meta
      FROM vendor_payin_orders WHERE vendor = 'POOLPAY' AND order_id = $1
  `, [orderId]);
  const ex = existing[0];
  const exMeta = ex?.meta ?? {};
  return {
    order: ex,
    deeplinks: exMeta.deeplinks ?? deeplinks,
    upiIntent: exMeta.upi_intent ?? upiIntent,
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
  const where = input.id ? "id = $1::uuid" : "order_id = $1";

  const cur = await rows<any>("vendorGateway",
    `SELECT id::text, order_id, status, COALESCE(rrn,'') AS rrn, meta
       FROM vendor_payin_orders WHERE ${where} AND vendor = 'POOLPAY'`, [key]);
  if (!cur.length) return { ok: false, status: 404, error: "not found" };
  const order = cur[0];

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

  // Duplicate-UTR blocking — a UTR/RRN may settle exactly one order.
  if (input.outcome === "SUCCESS" && input.utr?.trim()) {
    const dup = await rows<{ order_id: string }>("vendorGateway",
      `SELECT order_id FROM vendor_payin_orders WHERE rrn = $1 AND id <> $2::uuid LIMIT 1`,
      [input.utr.trim(), order.id]);
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
