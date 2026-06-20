// GET /api/v1/orders/[id]/status — current status + lifecycle timeline (BRD §19).

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["MERCHANT", "PROVIDER", "OPERATOR", "SUPER_ADMIN", "ADMIN", "FINANCE", "COMPLIANCE", "RISK"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;

  try {
    // [id] may be the order_ref or the uuid.
    const o = (await rows<any>("fifo", `
      SELECT id::text, order_ref, merchant_id, direction, amount_minor::text, currency, settlement_mode,
             status, risk_score, risk_decision, txn_ref, utr, tx_hash, created_at, completed_at
        FROM fifo_orders WHERE order_ref = $1 OR id::text = $1 LIMIT 1
    `, [id]))[0];
    if (!o) return NextResponse.json({ error: "order not found" }, { status: 404 });
    if (s.persona === "MERCHANT" && o.merchant_id !== s.scope_id)
      return NextResponse.json({ error: "not your order" }, { status: 403 });

    const timeline = await rows<any>("fifo", `
      SELECT from_status, to_status, actor, actor_kind, reason, at
        FROM fifo_order_events WHERE order_id = $1::uuid ORDER BY at ASC
    `, [o.id]).catch(() => []);

    return NextResponse.json({ order: o, timeline });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
