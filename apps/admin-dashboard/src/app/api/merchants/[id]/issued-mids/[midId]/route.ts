// POST /api/merchants/{id}/issued-mids/{midId}
//   { action: "deactivate", reason }  ask to take an ACTIVE MID out of use (Maker-Checker `mid.deactivate`)
//   { action: "withdraw" }            take back a MID still waiting for approval

import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { CHAIN_WRITE, requestMidDeactivate, withdrawMid } from "@/lib/chain-store";
import { chainErrorResponse, jsonBody, UUID_RE } from "@/lib/chain-http";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string; midId: string }> }) {
  const g = await gateOrResponse(CHAIN_WRITE);
  if ("response" in g) return g.response;
  const { id, midId } = await params;
  if (!UUID_RE.test(id) || !UUID_RE.test(midId)) return NextResponse.json({ error: "MID not found" }, { status: 404 });
  const b = await jsonBody(req);
  const by = { id: g.session.user_id, email: g.session.email };
  try {
    if (b?.action === "deactivate") return NextResponse.json({ ok: true, ...(await requestMidDeactivate(id, midId, by, String(b.reason ?? ""))) });
    if (b?.action === "withdraw") { await withdrawMid(id, midId, by); return NextResponse.json({ ok: true }); }
    return NextResponse.json({ error: "action must be deactivate or withdraw" }, { status: 400 });
  } catch (e) { return chainErrorResponse(e); }
}
