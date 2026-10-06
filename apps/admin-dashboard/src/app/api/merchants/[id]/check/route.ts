// GET /api/merchants/[id]/check — "Check this banker" (lib/banker-check): every gate a live order
// meets on this banker, in plain words. Creates nothing, asks no gateway, sends no callback.
// Staff only (it names the gateway): SUPER_ADMIN, ADMIN, OPERATOR, SUPPORT.

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { checkBankerById } from "@/lib/banker-check-store";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "OPERATOR", "SUPPORT"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  try {
    const r = await checkBankerById(id);
    if (!r) return NextResponse.json({ error: "banker not found" }, { status: 404 });
    return NextResponse.json({ ...r.result, checked_at: new Date().toISOString(), facts: r.facts });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
