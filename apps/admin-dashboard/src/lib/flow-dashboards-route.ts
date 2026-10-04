// One GET handler for the four flow dashboards (/api/flows/*). STAFF ONLY (they name gateways):
// SUPER_ADMIN, ADMIN, OPERATOR, COMPLIANCE, FINANCE, RISK, SUPPORT. Read-only.
// ?mode=live|test (default: the dashboard's own Test / Live setting), ?banker=<code>.

import { NextResponse, type NextRequest } from "next/server";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { STAFF_PERSONAS } from "@/lib/portal-scope";
import { getLivemode } from "@/lib/mode";
import { parseBanker, parseMode } from "@/lib/flow-dashboards";

export function flowRoute(load: (livemode: boolean, banker: string | null) => Promise<unknown>) {
  return async function GET(req: NextRequest) {
    const g = await gateOrResponse(STAFF_PERSONAS);
    if ("response" in g) return g.response;
    const sp = req.nextUrl.searchParams;
    try {
      const livemode = parseMode(sp.get("mode"), await getLivemode());
      return NextResponse.json(await load(livemode, parseBanker(sp.get("banker"))), { headers: { "Cache-Control": "no-store" } });
    } catch (err) {
      const e = pgError(err);
      return NextResponse.json(e.body, { status: e.status });
    }
  };
}
