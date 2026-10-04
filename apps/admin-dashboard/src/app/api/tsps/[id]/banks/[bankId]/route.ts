// PATCH /api/tsps/{id}/banks/{bankId}
//   { action: "confirm", reference }  the bank confirmed the TSP's authority (its letter / agreement)
//   { action: "end", notes }          the TSP no longer issues for this bank (refused while a banker uses it)

import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { CHAIN_WRITE, confirmTspBank, endTspBank } from "@/lib/chain-store";
import { chainErrorResponse, jsonBody, UUID_RE } from "@/lib/chain-http";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; bankId: string }> }) {
  const g = await gateOrResponse(CHAIN_WRITE);
  if ("response" in g) return g.response;
  const { id, bankId } = await params;
  if (!UUID_RE.test(id) || !UUID_RE.test(bankId)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const b = await jsonBody(req);
  const by = { id: g.session.user_id, email: g.session.email };
  try {
    if (b?.action === "confirm") await confirmTspBank(id, bankId, String(b.reference ?? ""), by);
    else if (b?.action === "end") {
      const notes = String(b.notes ?? "");
      if (notes.trim().length < 5) return NextResponse.json({ error: "say why in a note", code: "NOTE_REQUIRED" }, { status: 400 });
      await endTspBank(id, bankId, by, notes);
    } else return NextResponse.json({ error: "action must be confirm or end" }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (e) { return chainErrorResponse(e); }
}
