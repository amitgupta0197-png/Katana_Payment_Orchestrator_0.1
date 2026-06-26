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
  receiverVpa?: string | null;   // receiver / payee UPI VPA (the `pa` in the intent)
  customerPhone?: string | null;
  merchantId?: string | null;
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
    vendorTxnId = shortId("ppx");
    const query = buildUpiQuery({ payeeVpa: input.receiverVpa || undefined, orderId, amount: input.amount, note });
    deeplinks = buildDeeplinks(query);
    upiIntent = deeplinks.upi;
  }
  const meta = {
    deeplinks, upi_intent: upiIntent, qr_payload: upiIntent,
    receiver_vpa: input.receiverVpa ?? null, sender_vpa: input.customerVpa ?? null,
  };

  const inserted = await rows<any>("vendorGateway", `
    INSERT INTO vendor_payin_orders
      (tenant_id, vendor, merchant_id, pay_id, order_id, amount, currency_code, channel,
       vendor_txn_id, response_code, status, customer_vpa, customer_phone, meta)
    VALUES ('tenant-default','POOLPAY',$1,$2,$3,$4,$5,$6,$7,'U17',$8,$9,$10,$11::jsonb)
    ON CONFLICT (vendor, order_id) DO NOTHING
    RETURNING id::text, order_id, pay_id, vendor_txn_id, amount, currency_code, channel, status, created_at
  `, [input.merchantId ?? null, payId, orderId, input.amount, input.currency, input.channel ?? "UPI_INTENT",
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
