// /api/tsps/{id}
//   GET    the TSP, its checklist and score, next step, banks, documents, bankers, MID quota use,
//          stage history and its requests waiting for a checker
//   PATCH  edit details. A LIVE (or SUSPENDED) TSP's flows, quotas and type change through
//          Maker-Checker: the answer carries `request_id` when one was raised.

import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { CHAIN_READ, CHAIN_WRITE, tspDetail, updateTsp } from "@/lib/chain-store";
import { chainErrorResponse, jsonBody, UUID_RE } from "@/lib/chain-http";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(CHAIN_READ);
  if ("response" in g) return g.response;
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "TSP not found" }, { status: 404 });
  try { return NextResponse.json(await tspDetail(id)); } catch (e) { return chainErrorResponse(e); }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(CHAIN_WRITE);
  if ("response" in g) return g.response;
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "TSP not found" }, { status: 404 });
  const b = await jsonBody(req);
  if (!b) return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  const { code: _c, stage: _s, screening_result: _r, ...rest } = b;
  try { return NextResponse.json({ ok: true, ...(await updateTsp(id, rest, { id: g.session.user_id, email: g.session.email })) }); }
  catch (e) { return chainErrorResponse(e); }
}
