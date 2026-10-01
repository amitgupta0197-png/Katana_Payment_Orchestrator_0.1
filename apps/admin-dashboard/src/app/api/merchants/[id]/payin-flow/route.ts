// The pay-in flow of one banker (a `merchants` row): the flow in force, where it comes from
// (the banker's own setting or its merchant's), and what each flow still needs before the
// banker can take a live order on it (lib/payin-flow, lib/payin-flow-store).
//
//   GET  SUPER_ADMIN, PROVIDER (mapped bankers), MERCHANT (own)
//   PUT  SUPER_ADMIN   give the banker a flow of its own; flow UNSET returns it to its merchant's

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { resolveMerchantScope } from "@/lib/merchant-keys";
import { bankerFlowHistory, getEffectiveFlow, setBankerFlow } from "@/lib/payin-flow-store";
import { flowChangeSchema, flowReadiness } from "@/lib/payin-flow-api";

export const dynamic = "force-dynamic";

async function view(code: string, canEdit: boolean) {
  const [e, history, ready] = await Promise.all([getEffectiveFlow(code), bankerFlowHistory(code), flowReadiness([code])]);
  return {
    merchant_code: code,
    flow: e.flow, active: e.active, source: e.source,
    own: e.own, inherited: e.inherited, provider_id: e.providerId,
    readiness: ready.get(code) ?? { p2p: false, intent: false },
    history, can_edit: canEdit,
  };
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  const scope = await resolveMerchantScope(id, g.session);
  if ("response" in scope) return scope.response;
  try {
    return NextResponse.json(await view(scope.code, g.session.persona === "SUPER_ADMIN"));
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  const scope = await resolveMerchantScope(id, g.session);
  if ("response" in scope) return scope.response;
  let body;
  try { body = flowChangeSchema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const r = await setBankerFlow(scope.code, { flow: body.flow, active: body.active ?? null, by: g.session.email, note: body.note });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
    return NextResponse.json(await view(scope.code, true));
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
