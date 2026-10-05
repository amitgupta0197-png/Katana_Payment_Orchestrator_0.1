// One partner (lib/partner). `id` is the partner's id; a partner's own login uses "me".
//
//   GET   /api/partners/{id}     the partner, its bankers, sub-merchant counts and recent activity
//   PATCH /api/partners/{id}     Super Admin / Admin: { name?, status?, exclusive?, auto_approve?, own_gateway? }

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { providerBankers } from "@/lib/banker-switch-store";
import { getProviderFlow } from "@/lib/payin-flow-store";
import { can, eventsView, forbidden, isStaff, notFound, PARTNER_READERS, partnerInScope, partnerView } from "@/lib/partner/access";
import { PARTNER_STATUSES } from "@/lib/partner/rules";
import { listPartnerEvents, listSubs, updatePartner } from "@/lib/partner/store";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse([...PARTNER_READERS]);
  if ("response" in g) return g.response;
  try {
    const p = await partnerInScope(g.session, (await params).id);
    if (!p) return notFound();
    const staff = isStaff(g.session);
    const [bankers, flow, subs, events] = await Promise.all([
      providerBankers(p.provider_id), getProviderFlow(p.provider_id), listSubs(p.id, { limit: 500 }), listPartnerEvents(p.id, null, 50),
    ]);
    const count = (s: string) => subs.filter((x) => x.status === s).length;
    return NextResponse.json({
      partner: partnerView(p, staff), staff,
      can: { settings: can.settings(g.session), review: can.review(g.session), edit_subs: can.editSubs(g.session), keys: can.keys(g.session) },
      flow, bankers,
      subs: { total: subs.length, active: count("ACTIVE"), pending: count("PENDING"), rejected: count("REJECTED"), suspended: count("SUSPENDED") },
      events: eventsView(events, staff),
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const patchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  status: z.enum(PARTNER_STATUSES).optional(),
  exclusive: z.boolean().optional(),
  auto_approve: z.boolean().optional(),
  own_gateway: z.string().max(40).nullable().optional(),
}).strict();

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse([...PARTNER_READERS]);
  if ("response" in g) return g.response;
  if (!can.settings(g.session)) return forbidden("change a partner's settings");
  const p = patchSchema.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({ error: p.error.issues[0].message }, { status: 400 });
  try {
    const partner = await partnerInScope(g.session, (await params).id);
    if (!partner) return notFound();
    return NextResponse.json(await updatePartner(partner.id, p.data, `katana:${g.session.email}`));
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
