// Shared PoolPay pay-in order creation. Used by both the cockpit test endpoint
// and the merchant-signed /api/v1/poolpay/order endpoint so the deeplink/insert
// logic lives in one place. Idempotent on (vendor, order_id).

import { randomUUID } from "crypto";
import { rows } from "@/lib/pg";
import { buildUpiQuery, buildDeeplinks, poolpayLive, createOrderRemote, type DeepLinks } from "@/lib/poolpay";

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

export async function createPoolPayOrder(input: CreatePoolPayInput): Promise<CreatePoolPayResult> {
  const orderId = input.orderId;
  const note = `Order ${orderId}`;

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

  const { pool, active } = buildVpaPool(input);
  const mode = input.mode === "INTENT" ? "INTENT" : "QR";

  // Real PoolPay when configured (POOLPAY_MODE=live); deterministic sandbox otherwise.
  let payId: string, vendorTxnId: string, deeplinks: DeepLinks, upiIntent: string, status = "PENDING";
  if (poolpayLive()) {
    const r = await createOrderRemote({
      orderId, amount: input.amount, currency: input.currency,
      customerVpa: input.customerVpa ?? undefined, customerPhone: input.customerPhone ?? undefined, note,
    });
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
  const meta = {
    deeplinks, upi_intent: upiIntent, qr_payload: upiIntent,
    mode,                                  // QR | INTENT
    receiver_vpa: active ?? input.receiverVpa ?? null,
    vpa_pool: pool,                        // [{ vpa, status }] for backup failover
    sender_vpa: input.customerVpa ?? null,
    sub_mid_code: subMidCode,
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
