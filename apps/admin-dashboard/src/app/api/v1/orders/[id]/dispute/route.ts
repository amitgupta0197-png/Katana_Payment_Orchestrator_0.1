// POST /api/v1/orders/[id]/dispute — open a dispute on a completed/settled order
// (BRD §16). Body: { reason? }. Compliance/Risk/Admin.

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { disputeOrder } from "@/lib/fifo";

export const dynamic = "force-dynamic";

const schema = z.object({ reason: z.string().optional() });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "COMPLIANCE", "RISK"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  let body;
  try { body = schema.parse(await req.json().catch(() => ({}))); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  try {
    const r = await disputeOrder({ orderIdOrRef: id, reason: body.reason, actor: g.session.email });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status ?? 400 });
    return NextResponse.json({ ok: true, status: "DISPUTE" });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
