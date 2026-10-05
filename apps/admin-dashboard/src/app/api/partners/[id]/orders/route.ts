// A partner's orders (lib/partner): GET /api/partners/{id}/orders?sub=<sub id>&mode=live|test&limit=
// Each row says which sub-merchant it is for. A partner's own login sees the same list.

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { notFound, PARTNER_READERS, partnerInScope } from "@/lib/partner/access";
import { getSub, listPartnerOrders, listSubs } from "@/lib/partner/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse([...PARTNER_READERS]);
  if ("response" in g) return g.response;
  try {
    const p = await partnerInScope(g.session, (await params).id);
    if (!p) return notFound();
    const u = new URL(req.url);
    const subRef = u.searchParams.get("sub");
    const sub = subRef ? await getSub(p.id, subRef) : null;
    if (subRef && !sub) return notFound();
    const livemode = u.searchParams.get("mode") !== "test";
    const [orders, subs] = await Promise.all([
      listPartnerOrders(p.id, { subId: sub?.id ?? null, livemode, limit: Number(u.searchParams.get("limit") ?? 100) || 100 }),
      listSubs(p.id, { limit: 500 }),
    ]);
    const name = new Map(subs.map((s) => [s.id, { sub_code: s.sub_code, external_id: s.external_id, name: s.display_name || s.legal_name }]));
    return NextResponse.json({ livemode, orders: orders.map((o) => ({ ...o, sub_merchant: o.sub_merchant_id ? name.get(o.sub_merchant_id) ?? null : null })) });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
