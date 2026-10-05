// Partners (lib/partner): payment aggregators that onboard their own merchants on Katana.
//
//   GET  /api/partners                   staff: every partner, with its sub-merchants and today's volume
//   GET  /api/partners?candidates=1      staff: merchants that could be made a partner
//   POST /api/partners                   Super Admin / Admin: make a merchant a partner
//        { provider_id, code, name?, exclusive?, auto_approve?, own_gateway? }

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError, rows } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { STAFF_PERSONAS } from "@/lib/portal-scope";
import { can, forbidden } from "@/lib/partner/access";
import { partnerCodeProblem } from "@/lib/partner/rules";
import { createPartner, listPartners, PartnerInputError } from "@/lib/partner/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse([...STAFF_PERSONAS]);
  if ("response" in g) return g.response;
  try {
    const partners = await listPartners();
    if (new URL(req.url).searchParams.get("candidates")) {
      const taken = new Set(partners.map((p) => p.provider_id));
      const all = await rows<{ id: string; code: string | null; legal_name: string | null; status: string | null }>("provider",
        `SELECT id::text, code, legal_name, status FROM providers ORDER BY legal_name NULLS LAST LIMIT 1000`);
      return NextResponse.json({ candidates: all.filter((p) => !taken.has(p.id)) });
    }
    return NextResponse.json({ partners, can_create: can.settings(g.session) });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const createSchema = z.object({
  provider_id: z.string().uuid(),
  code: z.string().transform((c) => c.trim().toUpperCase()),
  name: z.string().max(200).nullable().optional(),
  exclusive: z.boolean().optional(),
  auto_approve: z.boolean().optional(),
  own_gateway: z.string().max(40).nullable().optional(),
});

export async function POST(req: Request) {
  const g = await gateOrResponse([...STAFF_PERSONAS]);
  if ("response" in g) return g.response;
  if (!can.settings(g.session)) return forbidden("make a partner");
  const p = createSchema.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({ error: p.error.issues[0].message, field: p.error.issues[0].path.join(".") }, { status: 400 });
  const codeProblem = partnerCodeProblem(p.data.code);
  if (codeProblem) return NextResponse.json({ error: codeProblem, field: "code" }, { status: 400 });
  try {
    const partner = await createPartner(p.data, `katana:${g.session.email}`);
    return NextResponse.json(partner, { status: 201 });
  } catch (err) {
    if (err instanceof PartnerInputError) return NextResponse.json({ error: err.message, code: err.code, field: err.problem.field }, { status: err.status });
    const e = pgError(err); return NextResponse.json(e.body, { status: e.status });
  }
}
