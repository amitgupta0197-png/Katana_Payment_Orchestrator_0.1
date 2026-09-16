// POST /api/v1/payouts/[id]/check — "Check status" on one provider payout (dashboard).
// Asks PayU now and applies only a valid move (lib/payu-payout-order); PayU's raw answer is
// kept on the order timeline. Operator-paid payouts have no provider to ask.
import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { rows } from "@/lib/pg";
import { loadPayuPayout, syncPayuPayout } from "@/lib/payu-payout-order";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "FINANCE", "OPERATOR", "MERCHANT"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  try {
    const ref = (await rows<{ id: string }>("fifo",
      `SELECT id::text FROM fifo_orders WHERE (order_ref=$1 OR id::text=$1) AND direction='PAYOUT' LIMIT 1`, [id]))[0];
    const o = ref ? await loadPayuPayout("id", ref.id) : null;
    if (!o) return NextResponse.json({ error: "not a provider payout" }, { status: 404 });
    if (g.session.persona === "MERCHANT" && o.merchant_id !== g.session.scope_id)
      return NextResponse.json({ error: "not found" }, { status: 404 });
    const r = await syncPayuPayout(o, { hint: "MANUAL_CHECK", minGapSeconds: 3 });
    const now = (await loadPayuPayout("id", o.id))!;
    return NextResponse.json({ outcome: r.outcome, detail: r.detail ?? null, status: now.status });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
