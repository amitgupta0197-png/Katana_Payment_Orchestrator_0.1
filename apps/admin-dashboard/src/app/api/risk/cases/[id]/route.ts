// PATCH /api/risk/cases/[id] — transition case state, attach evidence.
// Allowed transitions:
//   OPEN → UNDER_REVIEW → (CLOSED_CLEARED | CLOSED_BLOCKED | ESCALATED)
//   ESCALATED → CLOSED_CLEARED | CLOSED_BLOCKED

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { wormAppend } from "@/lib/worm";
import { publish } from "@/lib/events";

export const dynamic = "force-dynamic";

const ALLOWED: Record<string, Set<string>> = {
  OPEN:           new Set(["UNDER_REVIEW","CLOSED_CLEARED","CLOSED_BLOCKED","ESCALATED"]),
  UNDER_REVIEW:   new Set(["CLOSED_CLEARED","CLOSED_BLOCKED","ESCALATED"]),
  ESCALATED:      new Set(["CLOSED_CLEARED","CLOSED_BLOCKED"]),
  CLOSED_CLEARED: new Set(),
  CLOSED_BLOCKED: new Set(),
};

const schema = z.object({
  status: z.enum(["UNDER_REVIEW","CLOSED_CLEARED","CLOSED_BLOCKED","ESCALATED"]).optional(),
  assigned_to: z.string().optional(),
  decision_notes: z.string().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const before = (await rows<any>("riskVelocity",
      "SELECT status, entity_type, entity_id, assigned_to FROM aml_cases WHERE case_id=$1::uuid", [id]))[0];
    if (!before) return NextResponse.json({ error: "case not found" }, { status: 404 });

    if (body.status && !ALLOWED[before.status]?.has(body.status))
      return NextResponse.json({ error: `cannot transition ${before.status} → ${body.status}` }, { status: 409 });

    const sets: string[] = []; const args: unknown[] = [];
    if (body.status) {
      args.push(body.status); sets.push(`status = $${args.length}`);
      if (body.status.startsWith("CLOSED")) {
        sets.push(`decided_at = now()`);
        args.push(s.email); sets.push(`decided_by = $${args.length}`);
      }
    }
    if (body.assigned_to !== undefined) { args.push(body.assigned_to); sets.push(`assigned_to = $${args.length}`); }
    if (body.decision_notes !== undefined) { args.push(body.decision_notes); sets.push(`decision_notes = $${args.length}`); }
    if (!sets.length) return NextResponse.json({ error: "no fields supplied" }, { status: 400 });
    args.push(id);

    const r = await rows<any>("riskVelocity", `
      UPDATE aml_cases SET ${sets.join(", ")} WHERE case_id=$${args.length}::uuid
      RETURNING case_id::text, status, entity_type, entity_id, decided_at
    `, args);

    await wormAppend({
      actorId: s.user_id, actorEmail: s.email,
      action: `aml.case.${body.status ?? "update"}`,
      resourceType: "aml_case", resourceId: id,
      before: { status: before.status, assigned_to: before.assigned_to },
      after: { status: r[0].status, assigned_to: body.assigned_to, decision_notes: body.decision_notes },
    }).catch(() => null);

    if (body.status) {
      await publish({
        eventType: "risk.alert", producer: "risk_engine",
        entityType: before.entity_type, entityId: before.entity_id, actorId: s.user_id,
        payload: { kind: "case_status", case_id: id, from: before.status, to: r[0].status },
      });
    }
    return NextResponse.json({ ok: true, ...r[0] });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
