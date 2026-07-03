// A merchant's PoolPay pay-in orders for the merchant-module operations view:
// which payments are currently active, their mode (QR/non-QR), active receiver
// VPA and backup-pool health. SUPER_ADMIN/PROVIDER (scoped)/MERCHANT (own).
//   GET  — list this merchant's pay-in orders (operations view).
//   POST — create a PoolPay S2S pay-in order FOR this merchant (the merchant-scoped
//          equivalent of the cockpit's "Create S2S order"; tagged with merchant_id
//          so it routes through the merchant's sub-MID, honours block/high-amount
//          risk rules, and shows up in the operations list above).

import { NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "crypto";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { resolveMerchantScope } from "@/lib/merchant-keys";
import { createPoolPayOrder, MerchantBlockedError } from "@/lib/poolpay-order";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  const scope = await resolveMerchantScope(id, g.session);
  if ("response" in scope) return scope.response;

  try {
    const orders = await rows<any>("vendorGateway", `
      SELECT id::text, order_id, vendor, amount::float AS amount, currency_code, status,
             COALESCE(rrn,'') AS rrn, COALESCE(sub_mid_code,'') AS sub_mid_code,
             meta, created_at
        FROM vendor_payin_orders
       WHERE merchant_id = $1
       ORDER BY created_at DESC LIMIT 100
    `, [scope.code]).catch(() => []);

    const shaped = orders.map((o: any) => {
      const m = o.meta ?? {};
      const pool = Array.isArray(m.vpa_pool) ? m.vpa_pool : [];
      return {
        id: o.id, order_id: o.order_id, vendor: o.vendor, amount: o.amount, currency_code: o.currency_code,
        status: o.status, rrn: o.rrn, sub_mid_code: o.sub_mid_code, created_at: o.created_at,
        mode: m.mode ?? "QR",
        active_vpa: m.receiver_vpa ?? null,
        vpa_total: pool.length,
        vpa_remaining: pool.filter((p: any) => p.status === "READY").length,
        hold: m.hold === true,
        hold_reason: m.hold_reason ?? null,
        terminal: ["SUCCESS", "SUCCEEDED", "FAILED", "EXPIRED"].includes(o.status),
      };
    });
    const live = shaped.filter((o: any) => !o.terminal);
    return NextResponse.json({ merchant_code: scope.code, live, all: shaped });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const createSchema = z.object({
  amount: z.coerce.number().positive().max(1_000_000),
  currency: z.string().default("INR"),
  mode: z.enum(["QR", "INTENT"]).optional(),
  receiver_vpas: z.array(z.string()).max(30).optional(), // payee pool (backup failover)
  customer_vpa: z.string().optional(),                   // sender / payer VPA
  customer_phone: z.string().optional(),
  order_ref: z.string().max(60).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  const scope = await resolveMerchantScope(id, g.session);
  if ("response" in scope) return scope.response;

  let body;
  try { body = createSchema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  // Default the receiver VPA pool to the merchant's configured PoolPay settlement
  // VPA when the caller didn't supply one, so an operator can create an order with
  // just an amount.
  let receiverVpas = body.receiver_vpas?.map((v) => v.trim()).filter(Boolean) ?? [];
  if (!receiverVpas.length) {
    const cfg = await rows<{ settlement_vpa: string | null }>(
      "merchant", `SELECT poolpay->>'settlement_vpa' AS settlement_vpa FROM merchant_payment_config WHERE merchant_code = $1`,
      [scope.code],
    ).catch(() => []);
    const v = cfg[0]?.settlement_vpa?.trim();
    if (v) receiverVpas = [v];
  }
  if (!receiverVpas.length)
    return NextResponse.json({ error: "no receiver VPA — add one here or set a PoolPay settlement VPA in payment config" }, { status: 400 });

  try {
    const orderId = body.order_ref?.trim()
      || `KP-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 4).toUpperCase()}`;
    const r = await createPoolPayOrder({
      orderId,
      amount: body.amount,
      currency: body.currency,
      merchantId: scope.code,
      receiverVpas,
      mode: body.mode,
      customerVpa: body.customer_vpa ?? null,
      customerPhone: body.customer_phone ?? null,
    });
    if (r.reused) return NextResponse.json({ error: "order_ref already used" }, { status: 409 });
    if (!r.order) return NextResponse.json({ error: "order create failed" }, { status: 500 });
    return NextResponse.json({ order: r.order, deeplinks: r.deeplinks, upi_intent: r.upiIntent, qr_payload: r.upiIntent });
  } catch (err) {
    if (err instanceof MerchantBlockedError)
      return NextResponse.json({ error: "merchant is blocked — new pay-ins rejected" }, { status: 403 });
    const e = pgError(err); return NextResponse.json(e.body, { status: e.status });
  }
}
