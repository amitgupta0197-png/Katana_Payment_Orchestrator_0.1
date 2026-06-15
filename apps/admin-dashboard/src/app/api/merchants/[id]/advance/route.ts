// POST /api/merchants/[id]/advance — move a merchant to the next onboarding stage.
//
// SUPER_ADMIN can advance any stage. PROVIDER can advance APPLICATION + DOCS_PENDING
// + BANK_VERIFY (the steps the provider drives, per §2.2). Each transition flips one
// step boolean and updates `stage`; rejection sets stage='REJECTED'.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse, resolveProviderMerchants } from "@/lib/scope";

export const dynamic = "force-dynamic";

const STEP_TO_STAGE: Record<string, { from: string; to: string; persona_required: ("SUPER_ADMIN"|"PROVIDER")[] }> = {
  step_application:  { from: "APPLICATION",  to: "DOCS_PENDING", persona_required: ["SUPER_ADMIN", "PROVIDER"] },
  step_kyb_docs:     { from: "DOCS_PENDING", to: "SCREENING",    persona_required: ["SUPER_ADMIN", "PROVIDER"] },
  step_screening:    { from: "SCREENING",    to: "BANK_VERIFY",  persona_required: ["SUPER_ADMIN"] },
  step_bank_verify:  { from: "BANK_VERIFY",  to: "CONFIG",       persona_required: ["SUPER_ADMIN", "PROVIDER"] },
  step_config:       { from: "CONFIG",       to: "CONFIG",       persona_required: ["SUPER_ADMIN"] },
  step_approval:     { from: "CONFIG",       to: "LIVE",         persona_required: ["SUPER_ADMIN"] },
};

const schema = z.object({
  step: z.enum(["step_application","step_kyb_docs","step_screening","step_bank_verify","step_config","step_approval"]).optional(),
  risk_tier: z.enum(["LOW","MEDIUM","HIGH"]).optional(),
  notes: z.string().optional().default(""),
  reject: z.boolean().optional(),
}).refine((d) => d.step || d.reject, { message: "step or reject required" });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;

  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  // Scope check: PROVIDER can only advance mapped merchants.
  if (s.persona === "PROVIDER") {
    const codes = await resolveProviderMerchants(s);
    const m = await rows<any>("merchant", `SELECT merchant_code FROM merchants WHERE id = $1::uuid`, [id]);
    if (!m.length) return NextResponse.json({ error: "merchant not found" }, { status: 404 });
    if (!codes.includes(m[0].merchant_code))
      return NextResponse.json({ error: "merchant not mapped to your provider" }, { status: 403 });
  }

  try {
    if (body.reject) {
      const res = await rows<any>("merchant", `
        UPDATE merchants SET stage = 'REJECTED', updated_at = now()
         WHERE id = $1::uuid AND stage NOT IN ('LIVE','TERMINATED')
         RETURNING id, merchant_code, stage
      `, [id]);
      if (!res.length) return NextResponse.json({ error: "cannot reject from terminal stage" }, { status: 409 });
      await rows("merchant", `
        INSERT INTO merchant_activity (merchant_id, action, actor, payload)
        VALUES ($1::uuid, 'REJECTED', $2, $3::jsonb)
      `, [id, s.email, JSON.stringify({ notes: body.notes })]).catch(() => {});
      return NextResponse.json(res[0]);
    }

    const step = body.step!;
    const transition = STEP_TO_STAGE[step];
    if (!transition.persona_required.includes(s.persona as any))
      return NextResponse.json({ error: `${step} requires SUPER_ADMIN` }, { status: 403 });

    // Stage gate: only advance if we're at the expected from-stage.
    const cur = await rows<any>("merchant", `SELECT stage, ${step} AS already_done FROM merchants WHERE id = $1::uuid`, [id]);
    if (!cur.length) return NextResponse.json({ error: "merchant not found" }, { status: 404 });
    if (cur[0].already_done) return NextResponse.json({ error: `${step} already done` }, { status: 409 });
    if (cur[0].stage !== transition.from)
      return NextResponse.json({ error: `cannot advance ${step} from stage ${cur[0].stage}` }, { status: 409 });

    const setFragments: string[] = [`${step} = true`, `stage = $2`, `updated_at = now()`];
    const args: unknown[] = [id, transition.to];
    if (step === "step_screening" && body.risk_tier) {
      args.push(body.risk_tier);
      setFragments.push(`risk_tier = $${args.length}`);
    }
    if (step === "step_approval") {
      args.push(s.email);
      setFragments.push(`approved_at = now()`, `approved_by = $${args.length}`);
    }
    const res = await rows<any>("merchant", `
      UPDATE merchants SET ${setFragments.join(", ")}
       WHERE id = $1::uuid
       RETURNING id, merchant_code, stage, risk_tier, ${step} AS step_done
    `, args);

    await rows("merchant", `
      INSERT INTO merchant_activity (merchant_id, action, actor, payload)
      VALUES ($1::uuid, $2, $3, $4::jsonb)
    `, [id, `ADVANCE_${step.toUpperCase()}`, s.email, JSON.stringify({ from: cur[0].stage, to: transition.to, notes: body.notes })]).catch(() => {});

    return NextResponse.json(res[0]);
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
