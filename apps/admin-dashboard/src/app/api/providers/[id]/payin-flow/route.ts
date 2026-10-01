// The pay-in flow selected for one merchant (a `providers` row): P2P, Intent or Both, and for
// Both the flow in use. Every banker under the merchant takes it unless it has its own
// (lib/payin-flow, lib/payin-flow-store).
//
//   GET  SUPER_ADMIN, PROVIDER (own)   the setting and its change history
//   PUT  SUPER_ADMIN                   select the flow

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { getProviderFlow, providerFlowHistory, setProviderFlow } from "@/lib/payin-flow-store";
import { flowChangeSchema } from "@/lib/payin-flow-api";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  if (g.session.persona === "PROVIDER" && g.session.scope_id !== id)
    return NextResponse.json({ error: "merchants can only read own row" }, { status: 403 });
  try {
    const [flow, history] = await Promise.all([getProviderFlow(id), providerFlowHistory(id)]);
    return NextResponse.json({ ...flow, history, can_edit: g.session.persona === "SUPER_ADMIN" });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  let body;
  try { body = flowChangeSchema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const r = await setProviderFlow(id, { flow: body.flow, active: body.active ?? null, by: g.session.email, note: body.note });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.error === "merchant not found" ? 404 : 400 });
    return NextResponse.json({ ...r.flow, history: await providerFlowHistory(id) });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
