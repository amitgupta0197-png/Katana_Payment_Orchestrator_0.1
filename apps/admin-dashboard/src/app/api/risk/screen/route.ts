// POST /api/risk/screen — run sanctions + PEP screening for an entity.
// Body: { entity_type, entity_id, full_name, country?, dob?, identifier? }
// Returns hits + auto-opened case_id (if any).

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { screenName, openCaseFromScreening } from "@/lib/risk";
import { publish } from "@/lib/events";

export const dynamic = "force-dynamic";

const schema = z.object({
  entity_type: z.enum(["merchant","beneficiary","customer","director","payout"]),
  entity_id:   z.string().min(1),
  full_name:   z.string().min(1).max(200),
  country:     z.string().optional(),
  dob:         z.string().optional(),         // ISO date
  identifier:  z.string().optional(),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN","PROVIDER","MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const result = await screenName({ fullName: body.full_name, country: body.country });
    const run = await rows<{ run_id: string }>("riskVelocity", `
      INSERT INTO screening_runs
        (entity_type, entity_id, full_name, country, dob, identifier,
         hits_count, sanctions_hit, pep_hit, decision, raw_hits, actor_id)
      VALUES ($1, $2, $3, $4, $5::date, $6,
              $7, $8, $9, $10, $11::jsonb, $12)
      RETURNING run_id::text
    `, [
      body.entity_type, body.entity_id, body.full_name, body.country ?? null,
      body.dob ?? null, body.identifier ?? null,
      result.hits.length, result.sanctions_hit, result.pep_hit, result.decision,
      JSON.stringify(result.hits), s.user_id,
    ]);

    let caseId: string | null = null;
    if (result.decision !== "CLEAR") {
      caseId = await openCaseFromScreening({
        entityType: body.entity_type, entityId: body.entity_id,
        runId: run[0].run_id, screening: result, openedBy: s.email,
      });
      if (caseId) {
        await rows("riskVelocity",
          `UPDATE screening_runs SET triggered_case=$1::uuid WHERE run_id=$2::uuid`,
          [caseId, run[0].run_id]).catch(() => null);
      }
    }
    await publish({
      eventType: "risk.alert", producer: "risk_engine",
      entityType: body.entity_type, entityId: body.entity_id, actorId: s.user_id,
      payload: { kind: "screening", run_id: run[0].run_id, decision: result.decision, hits: result.hits.length, case_id: caseId },
    });
    return NextResponse.json({ run_id: run[0].run_id, ...result, case_id: caseId });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
