// PUT /api/merchants/{id}/integration/callbacks  { flow: "INTENT"|"P2P"|"PAYOUT", url: string|null, notes? }
// Asks to set (url) or clear (null) a banker's callback URL for one flow. Goes to Maker-Checker
// (`callback.set` / `callback.clear`); a second person's approval writes it and checks it.
// Staff: Super Admin, Admin.

import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { INTEGRATION_WRITE, requestCallbackChange } from "@/lib/integration-store";
import { parseCallbackFlow } from "@/lib/integration";
import { chainErrorResponse, jsonBody, UUID_RE } from "@/lib/chain-http";

export const dynamic = "force-dynamic";

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(INTEGRATION_WRITE);
  if ("response" in g) return g.response;
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "banker not found" }, { status: 404 });
  const b = await jsonBody(req);
  const flow = parseCallbackFlow(b?.flow);
  if (!b || !flow) return NextResponse.json({ error: "flow must be INTENT, P2P or PAYOUT" }, { status: 400 });
  const url = typeof b.url === "string" && b.url.trim() ? b.url.trim() : null;
  if (b.url != null && typeof b.url !== "string") return NextResponse.json({ error: "url must be a string or null" }, { status: 400 });
  try {
    const r = await requestCallbackChange(id, flow, url, { id: g.session.user_id, email: g.session.email },
      typeof b.notes === "string" && b.notes.trim() ? b.notes.trim() : undefined);
    return NextResponse.json({ ok: true, ...r }, { status: 202 });
  } catch (e) { return chainErrorResponse(e); }
}
