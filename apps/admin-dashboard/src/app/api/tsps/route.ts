// /api/tsps — TSPs (technology service providers): the aggregators, gateways and acquiring-bank
// arms a bank issues MIDs through (merchant 0018, lib/chain). Staff only; a TSP is a gateway's
// company and never reaches a merchant.
//   GET   every TSP with its stage, banks, bankers, active MIDs and checklist score
//   POST  { code, name, tsp_type, legal_name?, gateway_code?, rbi_licence_no?, pci_dss_cert_no?, contacts…,
//           allowed_flows?, max_mids_per_banker?, max_bankers?, notes? } → starts at APPLICATION

import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { CHAIN_READ, CHAIN_WRITE, createTsp, listTsps } from "@/lib/chain-store";
import { chainErrorResponse, jsonBody } from "@/lib/chain-http";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(CHAIN_READ);
  if ("response" in g) return g.response;
  try { return NextResponse.json({ tsps: await listTsps() }); } catch (e) { return chainErrorResponse(e); }
}

export async function POST(req: Request) {
  const g = await gateOrResponse(CHAIN_WRITE);
  if ("response" in g) return g.response;
  const b = await jsonBody(req);
  if (!b) return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  try {
    const r = await createTsp({ ...b, code: typeof b.code === "string" ? b.code.trim().toUpperCase() : b.code }, { id: g.session.user_id, email: g.session.email });
    return NextResponse.json(r, { status: 201 });
  } catch (e) { return chainErrorResponse(e); }
}
