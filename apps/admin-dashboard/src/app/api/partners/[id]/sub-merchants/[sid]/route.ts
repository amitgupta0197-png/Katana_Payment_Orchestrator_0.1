// One sub-merchant of a partner (lib/partner). `sid` is Katana's id (uuid or SM_…) or the partner's external_id.
//
//   GET   …/sub-merchants/{sid}          details, volume, recent orders and its history
//   PATCH …/sub-merchants/{sid}          change details, flows or limits (rupees)
//   POST  …/sub-merchants/{sid}          { action: approve | reject | suspend | reactivate | resubmit, reason? }
//                                        staff review; a partner may only send a rejected one back for review

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { actorOf, can, eventsView, forbidden, isStaff, notFound, PARTNER_READERS, partnerInScope } from "@/lib/partner/access";
import { actionNeedsReason, STAFF_ONLY_ACTIONS, SUB_ACTIONS } from "@/lib/partner/rules";
import { actOnSub, getSub, listPartnerEvents, listPartnerOrders, PartnerInputError, subTotals, updateSub } from "@/lib/partner/store";
import { subBodySchema } from "@/lib/partner/schemas";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; sid: string }> };

const fail = (err: unknown) => {
  if (err instanceof PartnerInputError) return NextResponse.json({ error: err.message, code: err.code, field: err.problem.field }, { status: err.status });
  const e = pgError(err); return NextResponse.json(e.body, { status: e.status });
};

export async function GET(req: Request, { params }: Ctx) {
  const g = await gateOrResponse([...PARTNER_READERS]);
  if ("response" in g) return g.response;
  try {
    const { id, sid } = await params;
    const p = await partnerInScope(g.session, id);
    const s = p ? await getSub(p.id, decodeURIComponent(sid)) : null;
    if (!p || !s) return notFound();
    const livemode = new URL(req.url).searchParams.get("mode") !== "test";
    const [totals, orders, events] = await Promise.all([
      subTotals(p.id, livemode), listPartnerOrders(p.id, { subId: s.id, livemode, limit: 50 }), listPartnerEvents(p.id, s.id, 50),
    ]);
    return NextResponse.json({ sub_merchant: s, livemode, totals: totals[s.id] ?? null, orders, events: eventsView(events, isStaff(g.session)) });
  } catch (err) { return fail(err); }
}

export async function PATCH(req: Request, { params }: Ctx) {
  const g = await gateOrResponse([...PARTNER_READERS]);
  if ("response" in g) return g.response;
  if (!can.editSubs(g.session)) return forbidden("change a sub-merchant");
  const b = subBodySchema.safeParse(await req.json().catch(() => null));
  if (!b.success) return NextResponse.json({ error: b.error.issues[0].message, field: b.error.issues[0].path.join(".") }, { status: 400 });
  try {
    const { id, sid } = await params;
    const p = await partnerInScope(g.session, id);
    const s = p ? await getSub(p.id, decodeURIComponent(sid)) : null;
    if (!p || !s) return notFound();
    return NextResponse.json(await updateSub(p, s, b.data, actorOf(g.session, p), isStaff(g.session)));
  } catch (err) { return fail(err); }
}

const actionSchema = z.object({ action: z.enum(SUB_ACTIONS), reason: z.string().max(500).nullable().optional() });

export async function POST(req: Request, { params }: Ctx) {
  const g = await gateOrResponse([...PARTNER_READERS]);
  if ("response" in g) return g.response;
  const b = actionSchema.safeParse(await req.json().catch(() => null));
  if (!b.success) return NextResponse.json({ error: b.error.issues[0].message }, { status: 400 });
  const { action, reason } = b.data;
  if (STAFF_ONLY_ACTIONS.includes(action) ? !can.review(g.session) : !can.editSubs(g.session)) return forbidden(`${action} a sub-merchant`);
  if (actionNeedsReason(action) && !reason?.trim()) return NextResponse.json({ error: "say why: the partner is shown the reason", field: "reason" }, { status: 400 });
  try {
    const { id, sid } = await params;
    const p = await partnerInScope(g.session, id);
    const s = p ? await getSub(p.id, decodeURIComponent(sid)) : null;
    if (!p || !s) return notFound();
    return NextResponse.json(await actOnSub(s, action, reason ?? null, actorOf(g.session, p)));
  } catch (err) { return fail(err); }
}
