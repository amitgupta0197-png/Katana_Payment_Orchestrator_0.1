// GET /api/portal/integration-health: per banker, are its API requests accepted, are payment
// messages reaching its server, and when money last landed on its UPI IDs (lib/integration-health).
// Merchant (PROVIDER) and banker (MERCHANT) logins, scoped to their own bankers (lib/portal-scope);
// for the mode the portal is switched to.

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { getLivemode } from "@/lib/mode";
import { portalScope } from "@/lib/portal-scope";
import { integrationHealth } from "@/lib/integration-health";

export const dynamic = "force-dynamic";

const MAX_BANKERS = 30;

export async function GET() {
  const g = await gateOrResponse(["PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  try {
    const scope = await portalScope(g.session);
    const livemode = await getLivemode();
    const bankers = await integrationHealth((scope.codes ?? []).slice(0, MAX_BANKERS), livemode);
    return NextResponse.json({ livemode, bankers });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
