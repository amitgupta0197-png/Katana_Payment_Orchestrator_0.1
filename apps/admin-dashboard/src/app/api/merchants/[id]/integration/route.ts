// GET /api/merchants/{id}/integration — a banker's integration at a glance (lib/integration-store):
// Key + Salt status (the Key and dates only; never the Salt or a hint of it), v2 API keys, webhook
// settings, the callback URL per flow with its checks, a health score per flow and overall, and
// the integration log. `?chain=1` answers the chain view instead (as …/integration/chain).
// Staff only.

import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { chainForBanker, getIntegration, INTEGRATION_READ } from "@/lib/integration-store";
import { chainErrorResponse, UUID_RE } from "@/lib/chain-http";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(INTEGRATION_READ);
  if ("response" in g) return g.response;
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "banker not found" }, { status: 404 });
  try {
    if (new URL(req.url).searchParams.get("chain") === "1") return NextResponse.json(await chainForBanker(id));
    return NextResponse.json(await getIntegration(id));
  } catch (e) { return chainErrorResponse(e); }
}
