// GET /api/banker-portal/purchases — the banker's own advance purchases (read-only;
// lifecycle transitions stay admin/finance-side). BANKER-gated, scoped to scope_id.
import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { listPurchases } from "@/lib/dt";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["BANKER"]);
  if ("response" in g) return g.response;
  const bankerId = g.session.scope_id;
  if (!bankerId) return NextResponse.json({ error: "BANKER session missing scope_id" }, { status: 400 });
  const purchases = await listPurchases({ banker_id: bankerId });
  return NextResponse.json({ purchases });
}
