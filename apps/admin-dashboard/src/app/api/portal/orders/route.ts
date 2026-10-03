// GET /api/portal/orders?q=… — order search (lib/order-timeline): one piece of text matched
// against Katana's order id, the merchant's own reference and the bank reference. Without q, the
// newest orders.
// Staff see every banker's orders; a merchant or banker session only its own (lib/portal-scope).

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { PORTAL_PERSONAS, portalScope } from "@/lib/portal-scope";
import { recentOrders, searchOrders } from "@/lib/order-timeline";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(PORTAL_PERSONAS);
  if ("response" in g) return g.response;
  const q = new URL(req.url).searchParams.get("q") ?? "";
  try {
    const scope = await portalScope(g.session);
    return NextResponse.json({ orders: q.trim() ? await searchOrders(q, scope) : await recentOrders(scope) });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
