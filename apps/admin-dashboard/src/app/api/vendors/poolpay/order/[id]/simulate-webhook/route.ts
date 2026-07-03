// POST /api/vendors/poolpay/order/:id/simulate-webhook — cockpit demo helper
// (SUPER_ADMIN). Sandbox has no live gateway to call the settlement webhook, so this
// invokes the SAME settlement-confirmation core (confirmPoolPayOrder, evidence
// WEBHOOK + settlement SETTLED) that the real public /api/vendors/poolpay/callback
// runs after signature verification — so the gateway-confirmation outcome is
// identical to a production gateway callback, without a self HTTP round-trip.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { genRrn, POOLPAY_TERMINAL } from "@/lib/poolpay";
import { confirmPoolPayOrder } from "@/lib/poolpay-order";

export const dynamic = "force-dynamic";

const schema = z.object({
  outcome: z.enum(["SUCCESS", "FAILED"]).default("SUCCESS"),
}).optional();

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const { id } = await params;

  let outcome: "SUCCESS" | "FAILED" = "SUCCESS";
  try { const b = schema.parse(await req.json().catch(() => undefined)); if (b?.outcome) outcome = b.outcome; }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }

  try {
    const cur = await rows<{ id: string; order_id: string; status: string }>("vendorGateway",
      `SELECT id::text, order_id, status FROM vendor_payin_orders WHERE id = $1::uuid AND vendor = 'POOLPAY'`, [id]);
    if (!cur.length) return NextResponse.json({ error: "not found" }, { status: 404 });
    const order = cur[0];
    if (POOLPAY_TERMINAL.has(order.status))
      return NextResponse.json({ error: `order already ${order.status}` }, { status: 409 });

    const r = await confirmPoolPayOrder({
      orderRef: order.order_id,
      outcome,
      utr: outcome === "SUCCESS" ? genRrn(order.id) : null,
      evidence: "WEBHOOK",
      actor: "gateway:poolpay (simulated)",
      settlementStatus: outcome === "SUCCESS" ? "SETTLED" : null,
      note: `simulated gateway webhook (sim_${order.id.slice(0, 8)})`,
    });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ simulated: true, idempotent_replay: r.idempotent ?? false, order: r.order });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
