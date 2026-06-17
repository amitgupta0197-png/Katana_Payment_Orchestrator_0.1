// GET /api/admin/dr — list drills
// POST /api/admin/dr — record a drill outcome

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { wormAppend } from "@/lib/worm";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  try {
    const drills = await rows<any>("audit", `
      SELECT drill_id::text, kind, status,
             rto_target_minutes, rpo_target_seconds,
             rto_observed_minutes, rpo_observed_seconds,
             COALESCE(runbook_url,'') AS runbook_url,
             COALESCE(notes,'') AS notes, COALESCE(ran_by,'') AS ran_by,
             started_at, completed_at, evidence
        FROM dr_drills ORDER BY started_at DESC LIMIT 100
    `).catch(() => []);
    return NextResponse.json({ drills });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const schema = z.object({
  kind: z.enum(["backup_restore","failover","chaos","queue_recovery"]),
  status: z.enum(["PASSED","FAILED"]),
  rto_target_minutes: z.number().int().nonnegative().optional(),
  rpo_target_seconds: z.number().int().nonnegative().optional(),
  rto_observed_minutes: z.number().int().nonnegative().optional(),
  rpo_observed_seconds: z.number().int().nonnegative().optional(),
  runbook_url: z.string().optional(),
  notes: z.string().optional(),
  evidence: z.record(z.unknown()).optional(),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const r = await rows<{ drill_id: string }>("audit", `
      INSERT INTO dr_drills
        (kind, status, rto_target_minutes, rpo_target_seconds,
         rto_observed_minutes, rpo_observed_seconds,
         runbook_url, notes, evidence, ran_by, completed_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, now())
      RETURNING drill_id::text
    `, [body.kind, body.status,
        body.rto_target_minutes ?? null, body.rpo_target_seconds ?? null,
        body.rto_observed_minutes ?? null, body.rpo_observed_seconds ?? null,
        body.runbook_url ?? null, body.notes ?? null,
        JSON.stringify(body.evidence ?? {}), s.email]);
    await wormAppend({
      actorId: s.user_id, actorEmail: s.email,
      action: `dr.drill.${body.status.toLowerCase()}`,
      resourceType: "dr_drill", resourceId: r[0].drill_id,
      before: null, after: body,
    }).catch(() => null);
    return NextResponse.json({ drill_id: r[0].drill_id });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
