// POST /api/merchants/{id}/issued-mids — record a MID the bank issued to this banker.
//   { flow: INTENT|P2P|PAYOUT, mid_value, issued_on?, expires_on?, daily_limit?, monthly_limit?, currency?, notes? }
// Saved PENDING_APPROVAL and sent to Maker-Checker (`mid.issue`); a second Super Admin makes it
// ACTIVE. Recording a MID moves no traffic: the MID switch still routes orders. Staff only.

import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { CHAIN_WRITE, requestMid } from "@/lib/chain-store";
import { chainErrorResponse, jsonBody, UUID_RE } from "@/lib/chain-http";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(CHAIN_WRITE);
  if ("response" in g) return g.response;
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "banker not found" }, { status: 404 });
  const b = await jsonBody(req);
  if (!b) return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  const num = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number(v));
  try {
    const r = await requestMid(id, {
      flow: b.flow, mid_value: b.mid_value, issued_on: b.issued_on || null, expires_on: b.expires_on || null,
      daily_limit: num(b.daily_limit), monthly_limit: num(b.monthly_limit), currency: b.currency || undefined, notes: b.notes ?? null,
    }, { id: g.session.user_id, email: g.session.email });
    return NextResponse.json({ ok: true, ...r }, { status: 201 });
  } catch (e) { return chainErrorResponse(e); }
}
