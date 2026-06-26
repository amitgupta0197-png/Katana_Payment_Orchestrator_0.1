// Multi-VPA failover: mark the current active receiver VPA FAILED and rotate to
// the next READY backup, regenerating the deeplinks + QR for the new VPA. Used
// when a payee VPA can't receive, so an order with a pool of 20-25 VPAs can still
// reach a successful outcome.
//
//   SUPER_ADMIN / MERCHANT — operate failover from the cockpit / merchant module.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { buildUpiQuery, buildDeeplinks } from "@/lib/poolpay";

export const dynamic = "force-dynamic";

interface PoolEntry { vpa: string; status: string }

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "MERCHANT"]);
  if ("response" in g) return g.response;
  const { id } = await params;

  try {
    const found = await rows<any>("vendorGateway",
      `SELECT id::text, order_id, amount, status, meta FROM vendor_payin_orders WHERE id = $1::uuid AND vendor = 'POOLPAY'`, [id]);
    if (!found.length) return NextResponse.json({ error: "not found" }, { status: 404 });
    const order = found[0];
    if (["SUCCESS", "SUCCEEDED", "FAILED", "EXPIRED"].includes(order.status))
      return NextResponse.json({ error: `order is ${order.status}` }, { status: 409 });

    const meta = order.meta ?? {};
    const pool: PoolEntry[] = Array.isArray(meta.vpa_pool) ? meta.vpa_pool : [];
    if (pool.length < 2) return NextResponse.json({ error: "no backup VPA available" }, { status: 409 });

    const activeIdx = pool.findIndex((p) => p.status === "ACTIVE");
    const nextIdx = pool.findIndex((p, i) => i > activeIdx && p.status === "READY");
    if (nextIdx === -1) return NextResponse.json({ error: "all backup VPAs exhausted" }, { status: 409 });

    if (activeIdx >= 0) pool[activeIdx].status = "FAILED";
    pool[nextIdx].status = "ACTIVE";
    const active = pool[nextIdx].vpa;

    const query = buildUpiQuery({ payeeVpa: active, orderId: order.order_id, amount: Number(order.amount), note: `Order ${order.order_id}` });
    const deeplinks = buildDeeplinks(query);
    const newMeta = { ...meta, vpa_pool: pool, receiver_vpa: active, deeplinks, upi_intent: deeplinks.upi, qr_payload: deeplinks.upi };

    const upd = await rows<any>("vendorGateway", `
      UPDATE vendor_payin_orders SET meta = $2::jsonb, updated_at = now()
       WHERE id = $1::uuid
      RETURNING id::text, order_id, status
    `, [id, JSON.stringify(newMeta)]);

    return NextResponse.json({
      ok: true, order: upd[0], active_vpa: active,
      remaining: pool.filter((p) => p.status === "READY").length,
      deeplinks, upi_intent: deeplinks.upi,
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
