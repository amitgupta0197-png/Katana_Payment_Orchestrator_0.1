// What one merchant (a `providers` row) is onboarded for: its services and its pay-in flow,
// chosen together (lib/merchant-services).
//
//   GET  SUPER_ADMIN   the merchant's bankers and what each would still need. With
//                      ?services=&flow=&active= it answers for that choice instead of the saved
//                      one: the warning shown before a change is saved. ?suggest=1 adds what the
//                      merchant most likely is, from its bankers' orders, payouts and setup.
//   PUT  SUPER_ADMIN   save both. A pay-out only merchant's flow is cleared.

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { merchantEvidence, merchantReadiness, type ProposedChoice } from "@/lib/merchant-setup";
import { setProviderServices } from "@/lib/merchant-services-store";
import { setProviderFlow } from "@/lib/payin-flow-store";
import { MERCHANT_SERVICES, suggestChoice, validateOnboardingChoice, type MerchantServicesSetting } from "@/lib/merchant-services";
import { merchantFlowOf, parseOrderFlow, parsePayinFlow } from "@/lib/payin-flow";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  const q = new URL(req.url).searchParams;
  const proposed: ProposedChoice = {};
  const s = (q.get("services") ?? "").toUpperCase();
  if (s === "UNSET" || (MERCHANT_SERVICES as readonly string[]).includes(s)) proposed.services = s as MerchantServicesSetting;
  if (q.has("flow")) proposed.flow = merchantFlowOf(parsePayinFlow(q.get("flow")), parseOrderFlow(q.get("active")));
  try {
    const m = (await merchantReadiness(id, proposed))[0];
    if (!m) return NextResponse.json({ error: "merchant not found" }, { status: 404 });
    // ?suggest=1: what the merchant most likely is, from what its bankers actually did.
    if (q.get("suggest") === "1") {
      const evidence = await merchantEvidence(id);
      return NextResponse.json({ ...m, evidence, suggestion: suggestChoice(evidence) });
    }
    return NextResponse.json(m);
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const schema = z.object({
  services: z.enum(["PAYIN", "PAYOUT", "BOTH"]),
  payin_flow: z.enum(["P2P", "INTENT", "BOTH"]).nullish(),
  payin_active_flow: z.enum(["P2P", "INTENT"]).nullish(),
  note: z.string().trim().max(300).optional(),
});

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  const bad = validateOnboardingChoice(body.services, body.payin_flow ?? null, body.payin_active_flow ?? null);
  if (bad) return NextResponse.json({ error: bad }, { status: 400 });
  try {
    const by = g.session.email;
    const sv = await setProviderServices(id, { services: body.services, by, note: body.note });
    if (!sv.ok) return NextResponse.json({ error: sv.error }, { status: sv.error === "merchant not found" ? 404 : 400 });
    const fl = await setProviderFlow(id, body.payin_flow
      ? { flow: body.payin_flow, active: body.payin_active_flow ?? null, by, note: body.note }
      : { flow: "UNSET", by, note: body.note });
    if (!fl.ok) return NextResponse.json({ error: fl.error }, { status: 400 });
    return NextResponse.json((await merchantReadiness(id))[0]);
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
