// GET /api/v1/{p2p|intent}/order/{id} — the status of one order of that flow.
//
// {id} is the order id returned when the order was created, or the flow's own reference
// (P2P-000000123 / INT-000000123). An order of the other flow is "not found" here: each flow's
// API only ever answers for its own orders. The body is the general status (lib/pay-status)
// plus `flow` and the flow reference. Public like /api/pay-status: the id is the capability.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { readOrderStatus } from "@/lib/pay-status";
import type { OrderFlow } from "@/lib/payin-flow";

const TABLE: Record<OrderFlow, { table: string; ref: string; re: RegExp }> = {
  P2P: { table: "katana_p2p_orders", ref: "p2p_ref", re: /^P2P-\d{1,12}$/i },
  INTENT: { table: "katana_intent_orders", ref: "intent_ref", re: /^INT-\d{1,12}$/i },
};

export async function flowOrderStatusGet(id: string, flow: OrderFlow): Promise<NextResponse> {
  const t = TABLE[flow];
  const byUuid = /^[0-9a-f-]{36}$/i.test(id);
  if (!byUuid && !t.re.test(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const found = await rows<{ order_id: string; ref: string }>("vendorGateway",
      `SELECT order_id::text, ${t.ref} AS ref FROM ${t.table} WHERE ${byUuid ? "order_id = $1::uuid" : `${t.ref} = upper($1)`}`, [id]);
    if (!found.length) return NextResponse.json({ error: "not found" }, { status: 404 });
    const status = await readOrderStatus(found[0].order_id);
    if (!status) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ flow, [t.ref]: found[0].ref, id: found[0].order_id, ...status }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
