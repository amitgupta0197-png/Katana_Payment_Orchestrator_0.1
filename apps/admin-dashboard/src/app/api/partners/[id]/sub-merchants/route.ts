// A partner's sub-merchants (lib/partner). Amounts here are rupees (the partner API speaks paise).
//
//   GET  /api/partners/{id}/sub-merchants?status=&q=&mode=live|test   the list, with today's and 30 days' volume
//   POST /api/partners/{id}/sub-merchants                             add one: staff-made are active at once,
//                                                                     the partner's own wait for review

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { actorOf, can, forbidden, isStaff, notFound, PARTNER_READERS, partnerInScope } from "@/lib/partner/access";
import { SUB_STATUSES, type SubStatus } from "@/lib/partner/rules";
import { subBodySchema } from "@/lib/partner/schemas";
import { createSub, listSubs, PartnerInputError, subTotals } from "@/lib/partner/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse([...PARTNER_READERS]);
  if ("response" in g) return g.response;
  try {
    const p = await partnerInScope(g.session, (await params).id);
    if (!p) return notFound();
    const u = new URL(req.url);
    const st = u.searchParams.get("status")?.toUpperCase() || null;
    const status = st && SUB_STATUSES.includes(st as SubStatus) ? (st as SubStatus) : null;
    const livemode = u.searchParams.get("mode") !== "test";
    const [subs, totals] = await Promise.all([listSubs(p.id, { status, q: u.searchParams.get("q"), limit: 500 }), subTotals(p.id, livemode)]);
    return NextResponse.json({
      livemode,
      sub_merchants: subs.map((s) => ({ ...s, totals: totals[s.id] ?? null })),
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}


export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse([...PARTNER_READERS]);
  if ("response" in g) return g.response;
  if (!can.editSubs(g.session)) return forbidden("add a sub-merchant");
  const b = subBodySchema.safeParse(await req.json().catch(() => null));
  if (!b.success) return NextResponse.json({ error: b.error.issues[0].message, field: b.error.issues[0].path.join(".") }, { status: 400 });
  try {
    const p = await partnerInScope(g.session, (await params).id);
    if (!p) return notFound();
    const s = await createSub(p, b.data, isStaff(g.session) ? "STAFF" : "PORTAL", actorOf(g.session, p));
    return NextResponse.json(s, { status: 201 });
  } catch (err) {
    if (err instanceof PartnerInputError) return NextResponse.json({ error: err.message, code: err.code, field: err.problem.field }, { status: err.status });
    const e = pgError(err); return NextResponse.json(e.body, { status: e.status });
  }
}
