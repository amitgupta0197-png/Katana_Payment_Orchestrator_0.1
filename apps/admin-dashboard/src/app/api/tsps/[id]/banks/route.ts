// POST /api/tsps/{id}/banks { bank_id } — say the TSP issues MIDs for this bank. It starts
// PENDING until the bank's confirmation is recorded (PATCH …/banks/{bankId}).

import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { CHAIN_WRITE, linkTspBank } from "@/lib/chain-store";
import { chainErrorResponse, jsonBody, UUID_RE } from "@/lib/chain-http";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(CHAIN_WRITE);
  if ("response" in g) return g.response;
  const { id } = await params;
  const b = await jsonBody(req);
  if (!UUID_RE.test(id) || !UUID_RE.test(String(b?.bank_id ?? ""))) return NextResponse.json({ error: "tsp id and bank_id required" }, { status: 400 });
  try { await linkTspBank(id, b!.bank_id, { id: g.session.user_id, email: g.session.email }); return NextResponse.json({ ok: true }, { status: 201 }); }
  catch (e) { return chainErrorResponse(e); }
}
