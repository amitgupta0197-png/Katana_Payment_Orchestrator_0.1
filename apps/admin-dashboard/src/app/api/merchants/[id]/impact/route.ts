// GET /api/merchants/[id]/impact?change=FLOW&to=P2P | change=ACCOUNT&gateway=PAYU | change=BLOCK
// "Before you save" for a risky change to one banker (lib/change-impact): what it would do to the
// orders it takes, from its recent orders. Reads only; the change itself is saved by its own route.
// Staff only (it names gateways): SUPER_ADMIN, ADMIN, OPERATOR.

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { bankerCheckFacts } from "@/lib/banker-check-store";
import { bankerOrderCounts, IMPACT_DAYS } from "@/lib/change-impact-store";
import { accountImpact, blockImpact, flowImpact } from "@/lib/change-impact";
import { gatewayName } from "@/lib/pg-catalog";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "OPERATOR"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  const u = new URL(req.url);
  const change = u.searchParams.get("change");
  try {
    const f = await bankerCheckFacts(id);
    if (!f) return NextResponse.json({ error: "banker not found" }, { status: 404 });
    const c = (await bankerOrderCounts([f.code])).get(f.code)!;
    if (change === "FLOW") {
      const to = (u.searchParams.get("to") ?? "").toUpperCase();
      if (!["P2P", "INTENT", "BOTH", "UNSET"].includes(to)) return NextResponse.json({ error: "to must be P2P, INTENT, BOTH or UNSET" }, { status: 400 });
      const intentReady = !!f.account && f.account.channel === "INTENT" && f.account.connector && f.account.env === "PROD";
      const p2pReady = !!f.upiId || (!!f.account && f.account.channel === "P2P");
      const ready = to === "P2P" ? p2pReady : to === "INTENT" ? intentReady : to === "BOTH" ? p2pReady || intentReady : true;
      return NextResponse.json(flowImpact(f.code, to as "P2P", c, ready, IMPACT_DAYS));
    }
    if (change === "ACCOUNT") {
      const next = gatewayName(u.searchParams.get("gateway") ?? "") || "the new gateway";
      return NextResponse.json(accountImpact(f.code, f.account?.gatewayName ?? null, next, c, IMPACT_DAYS));
    }
    if (change === "BLOCK") return NextResponse.json(blockImpact(f.code, c, IMPACT_DAYS));
    return NextResponse.json({ error: "change must be FLOW, ACCOUNT or BLOCK" }, { status: 400 });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
