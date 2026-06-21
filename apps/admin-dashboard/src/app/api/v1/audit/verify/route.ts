// GET /api/v1/audit/verify?order_ref=ORD-… — recompute an order's event hash
// chain and report integrity (BRD SEC-006 append-only, tamper-evident).

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { verifyEventChain } from "@/lib/fifo";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "COMPLIANCE", "RISK"]);
  if ("response" in g) return g.response;
  const ref = new URL(req.url).searchParams.get("order_ref");
  if (!ref) return NextResponse.json({ error: "order_ref required" }, { status: 400 });
  try {
    const o = (await rows<{ id: string }>("fifo", `SELECT id::text FROM fifo_orders WHERE order_ref=$1 OR id::text=$1 LIMIT 1`, [ref]))[0];
    if (!o) return NextResponse.json({ error: "order not found" }, { status: 404 });
    const r = await verifyEventChain(o.id);
    return NextResponse.json({ order_ref: ref, ...r });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
