// PoolPay S2S status enquiry (PRODUCT_VISION §3.6).
//   GET — poll an order's current status. In sandbox the status advances over
//   time (PENDING -> SUCCESS) or is forced by the amount (see decidePoolPayStatus).
//   Once terminal the row is sticky. Real integration would GET PoolPay /order/status.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { resolvePoolPay, genRrn, POOLPAY_TERMINAL } from "@/lib/poolpay";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "MERCHANT"]);
  if ("response" in g) return g.response;
  const { id } = await params;

  try {
    const found = await rows<any>("vendorGateway", `
      SELECT id::text, order_id, pay_id, vendor_txn_id, amount, currency_code, channel,
             COALESCE(rrn,'') AS rrn, response_code, status, customer_vpa, customer_phone,
             meta, created_at,
             EXTRACT(EPOCH FROM (now() - created_at))::int AS age_seconds
        FROM vendor_payin_orders
       WHERE id = $1::uuid AND vendor = 'POOLPAY'
    `, [id]);
    if (!found.length) return NextResponse.json({ error: "not found" }, { status: 404 });

    let order = found[0];
    if (!(order.meta?.hold === true)) { // held high-amount orders await manual confirm
      const amountMinor = Math.round(Number(order.amount) * 100);
      const decision = resolvePoolPay(order.status, amountMinor, order.age_seconds);
      if (decision.changed) {
        const rrn = decision.status === "SUCCESS" ? genRrn(order.id) : null;
        const upd = await rows<any>("vendorGateway", `
          UPDATE vendor_payin_orders
             SET status = $2, response_code = $3, rrn = COALESCE($4, rrn), updated_at = now()
           WHERE id = $1::uuid
          RETURNING id::text, order_id, pay_id, vendor_txn_id, amount, currency_code, channel,
                    COALESCE(rrn,'') AS rrn, response_code, status, customer_vpa, customer_phone,
                    meta, created_at
        `, [order.id, decision.status, decision.response_code, rrn]);
        order = upd[0];
      }
    }

    const meta = order.meta ?? {};
    return NextResponse.json({
      order,
      status: order.status,
      terminal: POOLPAY_TERMINAL.has(order.status),
      deeplinks: meta.deeplinks ?? null,
      upi_intent: meta.upi_intent ?? null,
      qr_payload: meta.qr_payload ?? null,
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
