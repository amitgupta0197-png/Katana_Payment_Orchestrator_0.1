// GET /api/partners/[id]/impact?change=EXCLUSIVE — "before you save" for making a partner
// exclusive (lib/change-impact exclusiveImpact): which of its bankers took orders signed with
// their own keys recently, which would be refused from then on. Reads only. Staff who may change
// partner settings (lib/partner/access can.settings).

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { can, forbidden, isStaff, notFound, PARTNER_READERS, partnerInScope } from "@/lib/partner/access";
import { providerBankers } from "@/lib/banker-switch-store";
import { bankerOrderCounts, IMPACT_DAYS } from "@/lib/change-impact-store";
import { exclusiveImpact } from "@/lib/change-impact";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse([...PARTNER_READERS]);
  if ("response" in g) return g.response;
  if (!isStaff(g.session) || !can.settings(g.session)) return forbidden("see this");
  const { id } = await params;
  if (new URL(req.url).searchParams.get("change") !== "EXCLUSIVE") return NextResponse.json({ error: "change must be EXCLUSIVE" }, { status: 400 });
  try {
    const p = await partnerInScope(g.session, id);
    if (!p) return notFound();
    const bankers = await providerBankers(p.provider_id);
    const counts = await bankerOrderCounts(bankers.map((b) => b.code));
    return NextResponse.json(exclusiveImpact(p.code, [...counts.values()], IMPACT_DAYS));
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
