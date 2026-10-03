// The services one merchant (a `providers` row) takes: pay-in, pay-out or both
// (lib/merchant-services). Every banker under the merchant obeys it.
//
//   GET  SUPER_ADMIN, PROVIDER (own)   the setting and its change history
//   PUT  SUPER_ADMIN                   select the services

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { getProviderServices, providerServicesHistory, setProviderServices } from "@/lib/merchant-services-store";

export const dynamic = "force-dynamic";

const schema = z.object({
  // UNSET clears the choice: the merchant may then do both, as before one was made.
  services: z.enum(["PAYIN", "PAYOUT", "BOTH", "UNSET"]),
  note: z.string().trim().max(300).optional(),
});

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  if (g.session.persona === "PROVIDER" && g.session.scope_id !== id)
    return NextResponse.json({ error: "merchants can only read own row" }, { status: 403 });
  try {
    const [services, history] = await Promise.all([getProviderServices(id), providerServicesHistory(id)]);
    return NextResponse.json({ services, history, can_edit: g.session.persona === "SUPER_ADMIN" });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const r = await setProviderServices(id, { services: body.services, by: g.session.email, note: body.note });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.error === "merchant not found" ? 404 : 400 });
    return NextResponse.json({ services: r.services, history: await providerServicesHistory(id) });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
