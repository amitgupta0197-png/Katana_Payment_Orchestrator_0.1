// PUBLIC PoolPay payment-page status endpoint (no session — the order id in the
// URL is the capability, same model as a hosted checkout link). Returns only the
// fields the customer-facing payment page needs: amount, status, deeplinks, QR.
// Whitelisted in middleware (PUBLIC_API_PREFIX).

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { decidePoolPayStatus, genRrn, POOLPAY_TERMINAL } from "@/lib/poolpay";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Guard against non-uuid ids hitting the DB with a cast error.
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  try {
    const found = await rows<any>("vendorGateway", `
      SELECT id::text, order_id, amount, currency_code, COALESCE(rrn,'') AS rrn,
             status, meta, EXTRACT(EPOCH FROM (now() - created_at))::int AS age_seconds
        FROM vendor_payin_orders
       WHERE id = $1::uuid AND vendor = 'POOLPAY'
    `, [id]);
    if (!found.length) return NextResponse.json({ error: "not found" }, { status: 404 });

    let order = found[0];
    if (!POOLPAY_TERMINAL.has(order.status)) {
      const amountMinor = Math.round(Number(order.amount) * 100);
      const decision = decidePoolPayStatus(amountMinor, order.age_seconds);
      if (decision.status !== order.status) {
        const rrn = decision.status === "SUCCESS" ? genRrn(order.id) : null;
        const upd = await rows<any>("vendorGateway", `
          UPDATE vendor_payin_orders
             SET status = $2, response_code = $3, rrn = COALESCE($4, rrn), updated_at = now()
           WHERE id = $1::uuid
          RETURNING id::text, order_id, amount, currency_code, COALESCE(rrn,'') AS rrn, status, meta
        `, [order.id, decision.status, decision.response_code, rrn]);
        order = upd[0];
      }
    }

    const meta = order.meta ?? {};
    return NextResponse.json({
      order_id: order.order_id,
      amount: Number(order.amount),
      currency_code: order.currency_code,
      status: order.status,
      terminal: POOLPAY_TERMINAL.has(order.status),
      rrn: order.rrn || null,
      deeplinks: meta.deeplinks ?? null,
      upi_intent: meta.upi_intent ?? null,
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
