// GET /api/merchants/{id}/integration/chain[?kind=provider]
// The chain Bank → TSP → Banker → Katana → Merchant (lib/integration-store), with a colour per
// node and per flow the MIDs and the callback URL. {id} is a banker (merchants row); with
// ?kind=provider it is a merchant (providers row) and every one of its bankers is answered.
// Staff only: it names the TSP, a gateway's company. Never for a merchant or banker login.

import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { chainForBanker, chainForProvider, INTEGRATION_READ } from "@/lib/integration-store";
import { chainErrorResponse, UUID_RE } from "@/lib/chain-http";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(INTEGRATION_READ);
  if ("response" in g) return g.response;
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const provider = new URL(req.url).searchParams.get("kind") === "provider";
    return NextResponse.json(provider ? await chainForProvider(id) : await chainForBanker(id));
  } catch (e) { return chainErrorResponse(e); }
}
