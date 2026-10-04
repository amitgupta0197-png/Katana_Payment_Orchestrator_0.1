// PATCH /api/banks/{id} — edit a bank: name, type, settlement account, rails, contact, ACTIVE / INACTIVE.

import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { CHAIN_WRITE, updateBank } from "@/lib/chain-store";
import { chainErrorResponse, jsonBody, UUID_RE } from "@/lib/chain-http";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(CHAIN_WRITE);
  if ("response" in g) return g.response;
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "bank not found" }, { status: 404 });
  const b = await jsonBody(req);
  if (!b) return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  const { code: _code, ...rest } = b;
  try { await updateBank(id, rest, { id: g.session.user_id, email: g.session.email }); return NextResponse.json({ ok: true }); }
  catch (e) { return chainErrorResponse(e); }
}
