// POST /api/merchants/{id}/integration/verify  { flow: "INTENT"|"P2P"|"PAYOUT"|null }
// Checks a callback URL now (lib/callback-verify): the flow's own URL, or the banker's default
// webhook URL for null. Records the check and answers its result. Staff: Super Admin, Admin.

import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { INTEGRATION_WRITE } from "@/lib/integration-store";
import { verifyCallback } from "@/lib/callback-verify";
import { parseCallbackFlow } from "@/lib/integration";
import { chainErrorResponse, jsonBody, UUID_RE } from "@/lib/chain-http";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(INTEGRATION_WRITE);
  if ("response" in g) return g.response;
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "banker not found" }, { status: 404 });
  const b = (await jsonBody(req)) ?? {};
  const flow = b.flow == null || b.flow === "" ? null : parseCallbackFlow(b.flow);
  if (b.flow != null && b.flow !== "" && !flow) return NextResponse.json({ error: "flow must be INTENT, P2P, PAYOUT or null" }, { status: 400 });
  try {
    const r = await verifyCallback({ merchantId: id, flow, triggeredBy: "MANUAL", actor: g.session.email });
    if (!r.url) return NextResponse.json({ error: r.error ?? "no callback URL set", code: "NO_URL" }, { status: 409 });
    return NextResponse.json(r);
  } catch (e) {
    if ((e as Error).message === "banker not found") return NextResponse.json({ error: "banker not found" }, { status: 404 });
    return chainErrorResponse(e);
  }
}
