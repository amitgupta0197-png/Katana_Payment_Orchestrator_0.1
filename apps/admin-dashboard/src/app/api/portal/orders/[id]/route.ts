// GET /api/portal/orders/{id} — one order's timeline (lib/order-timeline): the order as
// created, each status change, each webhook delivery attempt. An order outside the session's
// scope is "not found", not "forbidden": whether it exists is information too.

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { PORTAL_PERSONAS, portalScope } from "@/lib/portal-scope";
import { orderTimeline } from "@/lib/order-timeline";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(PORTAL_PERSONAS);
  if ("response" in g) return g.response;
  try {
    const scope = await portalScope(g.session);
    const t = await orderTimeline((await params).id, scope);
    if (!t) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ ...t, staff: scope.staff });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
