// POST /api/risk/payin-flags/[id] — record a person's decision on a compliance flag (audited).
//   CLEARED    looked at, nothing to report
//   ESCALATED  passed to the compliance officer
//   REPORTED   a report (STR / CTR) was filed; the note says which
import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { wormAppend } from "@/lib/worm";
import { reviewComplianceFlag } from "@/lib/payin-compliance-store";

export const dynamic = "force-dynamic";

const schema = z.object({
  status: z.enum(["CLEARED", "ESCALATED", "REPORTED"]),
  note: z.string().trim().min(3, "say what was found").max(1000),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "RISK", "COMPLIANCE"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  if (!/^\d+$/.test(id)) return NextResponse.json({ error: "flag not found" }, { status: 404 });
  let body;
  try { body = schema.parse(await req.json()); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  try {
    const r = await reviewComplianceFlag(id, body.status, g.session.email, body.note);
    if (!r) return NextResponse.json({ error: "flag not found" }, { status: 404 });
    await wormAppend({
      actorId: g.session.user_id, actorEmail: g.session.email, action: `compliance.payin_flag.${body.status.toLowerCase()}`,
      resourceType: "payin_compliance_flag", resourceId: id,
      before: { status: r.before.status }, after: { status: r.after.status, merchant_id: r.after.merchant_id, rule: r.after.rule, flag_date: r.after.flag_date },
      notes: body.note,
    }).catch(() => {});
    return NextResponse.json({ flag: r.after });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
