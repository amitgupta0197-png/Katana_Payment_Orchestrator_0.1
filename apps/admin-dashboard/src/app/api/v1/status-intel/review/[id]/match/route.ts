// POST /api/v1/status-intel/review/[id]/match — manually attach a review-queue
// signal to an order, then re-resolve. Body: { order_ref }.

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { manualMatch } from "@/lib/status-intelligence";

export const dynamic = "force-dynamic";

const schema = z.object({ order_ref: z.string().min(1) });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "OPERATOR", "FINANCE", "RISK"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  let body: z.infer<typeof schema>;
  try { body = schema.parse(await req.json()); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  try {
    const r = await manualMatch(id, body.order_ref, g.session.email);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 409 });
    return NextResponse.json({ ok: true, resolution: r.resolution });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
