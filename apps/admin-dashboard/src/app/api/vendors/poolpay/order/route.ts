// PoolPay S2S order creation — COCKPIT test endpoint (session-gated).
//   SUPER_ADMIN / MERCHANT — create a pay-in order; returns the deeplink response
//   (Paytm / PhonePe / generic UPI + QR payload) the payment page renders.
//
// The production path is the merchant-signed POST /api/v1/poolpay/order. Both
// share createPoolPayOrder() so the deeplink/insert logic lives in one place.

import { NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "crypto";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { createPoolPayOrder } from "@/lib/poolpay-order";

export const dynamic = "force-dynamic";

const schema = z.object({
  amount: z.coerce.number().positive().max(1_000_000),
  currency: z.string().default("INR"),
  customer_vpa: z.string().optional(),         // sender / payer VPA
  receiver_vpa: z.string().optional(),         // single receiver VPA
  receiver_vpas: z.array(z.string()).max(30).optional(), // receiver VPA pool (backup failover)
  mode: z.enum(["QR", "INTENT"]).optional(),   // QR vs non-QR deeplink
  customer_phone: z.string().optional(),
  order_ref: z.string().max(60).optional(),
  channel: z.string().default("UPI_INTENT"),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "MERCHANT"]);
  if ("response" in g) return g.response;

  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const orderId = body.order_ref?.trim()
      || `KP-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 4).toUpperCase()}`;

    const r = await createPoolPayOrder({
      orderId,
      amount: body.amount,
      currency: body.currency,
      channel: body.channel,
      customerVpa: body.customer_vpa ?? null,
      receiverVpa: body.receiver_vpa ?? null,
      receiverVpas: body.receiver_vpas,
      mode: body.mode,
      customerPhone: body.customer_phone ?? null,
    });
    if (r.reused) return NextResponse.json({ error: "order_ref already used" }, { status: 409 });
    if (!r.order) return NextResponse.json({ error: "order create failed" }, { status: 500 });

    return NextResponse.json({ order: r.order, deeplinks: r.deeplinks, upi_intent: r.upiIntent, qr_payload: r.upiIntent });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
