// GET  /api/risk/cases — list AML cases (BRD §9 P5 case workflow).
// POST /api/risk/cases — manually open a case.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { publish } from "@/lib/events";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN","PROVIDER"]);
  if ("response" in g) return g.response;
  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  try {
    const where: string[] = [];
    const params: unknown[] = [];
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    const open = await rows<any>("riskVelocity", `
      SELECT case_id::text, entity_type, entity_id, source, severity, status,
             summary, COALESCE(decision_notes,'') AS decision_notes,
             opened_at, COALESCE(opened_by,'') AS opened_by,
             COALESCE(assigned_to,'') AS assigned_to,
             decided_at, COALESCE(decided_by,'') AS decided_by,
             evidence
        FROM aml_cases
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY (status='OPEN') DESC, severity DESC, opened_at DESC LIMIT 200
    `, params);
    return NextResponse.json({ cases: open });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const createSchema = z.object({
  entity_type: z.string().min(1),
  entity_id:   z.string().min(1),
  source:      z.string().default("manual"),
  severity:    z.enum(["LOW","MEDIUM","HIGH","CRITICAL"]).default("MEDIUM"),
  summary:     z.string().min(1),
  evidence:    z.array(z.unknown()).optional(),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;
  let body;
  try { body = createSchema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const r = await rows<{ case_id: string }>("riskVelocity", `
      INSERT INTO aml_cases (entity_type, entity_id, source, severity, summary, evidence, opened_by)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
      RETURNING case_id::text
    `, [body.entity_type, body.entity_id, body.source, body.severity, body.summary,
        JSON.stringify(body.evidence ?? []), s.email]);
    await publish({
      eventType: "risk.alert", producer: "risk_engine",
      entityType: body.entity_type, entityId: body.entity_id, actorId: s.user_id,
      payload: { kind: "case_opened", case_id: r[0].case_id, severity: body.severity, source: body.source },
    });
    return NextResponse.json({ case_id: r[0].case_id, status: "OPEN" });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
