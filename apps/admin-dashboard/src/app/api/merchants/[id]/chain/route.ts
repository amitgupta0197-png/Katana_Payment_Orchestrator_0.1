// /api/merchants/{id}/chain — a banker's place in the Bank → TSP → Banker chain (lib/chain).
// Staff only: the TSP is a gateway's company and is never shown to a merchant or banker login.
//   GET  its TSP, issuing bank, issued MIDs and their history, and the LIVE TSPs / banks it could use
//   PUT  { tsp_id, bank_id }  put it on a LIVE TSP with a bank that TSP is confirmed for

import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { bankerChain, CHAIN_READ, CHAIN_WRITE, setBankerChain } from "@/lib/chain-store";
import { chainErrorResponse, jsonBody, UUID_RE } from "@/lib/chain-http";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(CHAIN_READ);
  if ("response" in g) return g.response;
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "banker not found" }, { status: 404 });
  try { return NextResponse.json(await bankerChain(id)); } catch (e) { return chainErrorResponse(e); }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(CHAIN_WRITE);
  if ("response" in g) return g.response;
  const { id } = await params;
  const b = await jsonBody(req);
  if (!UUID_RE.test(id) || !UUID_RE.test(String(b?.tsp_id ?? "")) || !UUID_RE.test(String(b?.bank_id ?? "")))
    return NextResponse.json({ error: "tsp_id and bank_id required" }, { status: 400 });
  try { await setBankerChain(id, b!.tsp_id, b!.bank_id, { id: g.session.user_id, email: g.session.email }); return NextResponse.json({ ok: true }); }
  catch (e) { return chainErrorResponse(e); }
}
