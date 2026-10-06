// One decision on one unmatched payment (lib/unmatched-store).
//   POST /api/unmatched/{alertId} { action: "link", order_id } | { action: "not_order", note? }
//                                 | { action: "approve" | "reject" | "undo", note? }   (staff)
// A link from a merchant or banker login waits for staff; staff who resolve payments link at once,
// through lib/credit-link-store. A payment outside the login's scope is "not found".

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { PORTAL_PERSONAS } from "@/lib/portal-scope";
import { actOnUnmatched, UnmatchedError } from "@/lib/unmatched-store";

export const dynamic = "force-dynamic";

const schema = z.object({
  action: z.enum(["link", "not_order", "approve", "reject", "undo"]),
  order_id: z.string().uuid().optional(),
  note: z.string().trim().max(300).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ alertId: string }> }) {
  const g = await gateOrResponse(PORTAL_PERSONAS);
  if ("response" in g) return g.response;
  const { alertId } = await params;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    return NextResponse.json(await actOnUnmatched(g.session, alertId, body.action, { orderId: body.order_id, note: body.note }));
  } catch (err) {
    if (err instanceof UnmatchedError) return NextResponse.json({ error: err.message }, { status: err.status });
    const e = pgError(err); return NextResponse.json(e.body, { status: e.status });
  }
}
