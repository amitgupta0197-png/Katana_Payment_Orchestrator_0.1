// PoolPay S2S order creation (PRODUCT_VISION §3.6).
//   SUPER_ADMIN / MERCHANT — create a pay-in order; returns the deeplink response
//   (Paytm / PhonePe / generic UPI + QR payload) the payment page renders.
//
// Sandbox: the order is persisted at PENDING and settled by the status-enquiry
// endpoint. Real PoolPay integration would POST to their S2S /order/create here.

import { NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "crypto";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { buildUpiQuery, buildDeeplinks } from "@/lib/poolpay";

export const dynamic = "force-dynamic";

const schema = z.object({
  amount: z.coerce.number().positive().max(1_000_000),
  currency: z.string().default("INR"),
  customer_vpa: z.string().optional(),
  customer_phone: z.string().optional(),
  order_ref: z.string().max(60).optional(),
  channel: z.string().default("UPI_INTENT"),
});

function shortId(prefix: string) {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "MERCHANT"]);
  if ("response" in g) return g.response;

  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const orderId = body.order_ref?.trim()
      || `PP-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 4).toUpperCase()}`;
    const payId = shortId("pay");
    const vendorTxnId = shortId("ppx");
    const note = `Order ${orderId}`;
    const query = buildUpiQuery({ orderId, amount: body.amount, note });
    const deeplinks = buildDeeplinks(query);
    const upiIntent = deeplinks.upi;
    const meta = { deeplinks, upi_intent: upiIntent, qr_payload: upiIntent };

    const res = await rows<any>("vendorGateway", `
      INSERT INTO vendor_payin_orders
        (tenant_id, vendor, pay_id, order_id, amount, currency_code, channel,
         vendor_txn_id, response_code, status, customer_vpa, customer_phone, meta)
      VALUES ('tenant-default','POOLPAY',$1,$2,$3,$4,$5,$6,'U17','PENDING',$7,$8,$9::jsonb)
      ON CONFLICT (vendor, order_id) DO NOTHING
      RETURNING id::text, order_id, pay_id, vendor_txn_id, amount, currency_code, channel, status, created_at
    `, [payId, orderId, body.amount, body.currency, body.channel, vendorTxnId,
        body.customer_vpa ?? null, body.customer_phone ?? null, JSON.stringify(meta)]);

    if (!res.length)
      return NextResponse.json({ error: "order_ref already used" }, { status: 409 });

    return NextResponse.json({ order: res[0], deeplinks, upi_intent: upiIntent, qr_payload: upiIntent });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
