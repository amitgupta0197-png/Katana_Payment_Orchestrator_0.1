// GET  /api/v1/status-intel/transaction/[ref] — full status-intelligence view of one
//      order: the order, its resolved canonical status, and every source signal.
// POST /api/v1/status-intel/transaction/[ref] — force a re-resolution.

import { NextResponse } from "next/server";
import { pgError, rows } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { getTransactionView, resolveStatus } from "@/lib/status-intelligence";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ ref: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "OPERATOR", "FINANCE", "RISK", "COMPLIANCE", "MERCHANT"]);
  if ("response" in g) return g.response;
  const { ref } = await params;
  try {
    const view = await getTransactionView(ref);
    if (!view) return NextResponse.json({ error: `order ${ref} not found` }, { status: 404 });
    return NextResponse.json(view);
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

export async function POST(_req: Request, { params }: { params: Promise<{ ref: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "OPERATOR", "FINANCE", "RISK"]);
  if ("response" in g) return g.response;
  const { ref } = await params;
  try {
    const o = (await rows<{ id: string }>("fifo", `SELECT id::text FROM fifo_orders WHERE order_ref = $1 LIMIT 1`, [ref]))[0];
    if (!o) return NextResponse.json({ error: `order ${ref} not found` }, { status: 404 });
    return NextResponse.json({ ok: true, resolution: await resolveStatus(o.id) });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
