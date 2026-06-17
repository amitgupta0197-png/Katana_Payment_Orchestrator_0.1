// Maker-checker queue (BRD §4 P0 acceptance: "Provider cannot approve own KYC").
//
// GET  — list pending requests (and recent decided ones).
// POST — decide a request: {request_id, decision: APPROVED|REJECTED, notes?}
//        On APPROVE for provider.* actions, applies the underlying change and
//        writes a WORM audit row. On REJECT, just records the decision.
//
// Persona: SUPER_ADMIN only.
// Self-approval guard: the checker must differ from the maker.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { wormAppend } from "@/lib/worm";
import { publish } from "@/lib/events";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  try {
    const pending = await rows<any>("provider", `
      SELECT request_id::text, resource_type, resource_id, action, payload,
             maker_id, COALESCE(maker_email,'') AS maker_email, status, created_at
        FROM maker_checker_requests
       WHERE status = 'PENDING'
       ORDER BY created_at ASC
    `);
    const recent = await rows<any>("provider", `
      SELECT request_id::text, resource_type, resource_id, action, payload,
             COALESCE(maker_email,'') AS maker_email, status,
             COALESCE(checker_email,'') AS checker_email,
             COALESCE(decision_notes,'') AS decision_notes,
             created_at, decided_at
        FROM maker_checker_requests
       WHERE status IN ('APPROVED','REJECTED')
       ORDER BY decided_at DESC LIMIT 50
    `);
    return NextResponse.json({ pending, recent });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const decideSchema = z.object({
  request_id: z.string().uuid(),
  decision: z.enum(["APPROVED", "REJECTED"]),
  notes: z.string().optional(),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;

  let body;
  try { body = decideSchema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  try {
    const reqRow = await rows<any>("provider", `
      SELECT request_id::text, resource_type, resource_id, action, payload,
             maker_id, maker_email, status
        FROM maker_checker_requests
       WHERE request_id = $1::uuid
    `, [body.request_id]);
    if (!reqRow.length) return NextResponse.json({ error: "request not found" }, { status: 404 });
    const r = reqRow[0];
    if (r.status !== "PENDING")
      return NextResponse.json({ error: `request already ${r.status}` }, { status: 409 });
    if (r.maker_id === s.user_id)
      return NextResponse.json({ error: "maker cannot be the checker (self-approval blocked)" }, { status: 403 });

    if (body.decision === "REJECTED") {
      await rows("provider", `
        UPDATE maker_checker_requests
           SET status='REJECTED', checker_id=$1, checker_email=$2,
               decision_notes=$3, decided_at=now()
         WHERE request_id=$4::uuid
      `, [s.user_id, s.email, body.notes ?? null, body.request_id]);
      await wormAppend({
        actorId: s.user_id, actorEmail: s.email,
        action: r.action + ".rejected",
        resourceType: r.resource_type, resourceId: r.resource_id,
        before: null, after: { decision: "REJECTED", payload: r.payload },
        notes: body.notes,
      });
      await publish({
        eventType: "maker_checker.decided", producer: "provider_mgmt",
        entityType: r.resource_type, entityId: r.resource_id, actorId: s.user_id,
        payload: { request_id: body.request_id, decision: "REJECTED", action: r.action },
      });
      return NextResponse.json({ ok: true, decision: "REJECTED" });
    }

    // APPROVED — apply the underlying change.
    let applied: any = null;
    if (r.resource_type === "provider") {
      const before = await rows<any>("provider",
        "SELECT kyc_status, status FROM providers WHERE id = $1::uuid", [r.resource_id]);
      if (!before.length) return NextResponse.json({ error: "target provider missing" }, { status: 404 });

      const fields: Record<string, unknown> = {};
      if (r.payload?.kyc_status) fields.kyc_status = r.payload.kyc_status;
      if (r.payload?.status)     fields.status     = r.payload.status;
      const sets: string[] = []; const args: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) {
        args.push(v); sets.push(`${k} = $${args.length}`);
      }
      args.push(r.resource_id);
      applied = (await rows<any>("provider", `
        UPDATE providers SET ${sets.join(", ")}, updated_at = now()
         WHERE id = $${args.length}::uuid
         RETURNING id::text, code, kyc_status, status, updated_at
      `, args))[0];

      await rows("provider", `
        INSERT INTO provider_audit_logs (provider_id, actor, action, before_state, after_state)
        VALUES ($1::uuid, $2, $3, $4::jsonb, $5::jsonb)
      `, [r.resource_id, s.email, r.action, JSON.stringify(before[0]), JSON.stringify(fields)]).catch(() => {});

      await wormAppend({
        actorId: s.user_id, actorEmail: s.email,
        action: r.action,
        resourceType: "provider", resourceId: r.resource_id,
        before: before[0], after: fields, notes: body.notes,
      });

      await publish({
        eventType: "provider.kyc_decided", producer: "provider_mgmt",
        entityType: "provider", entityId: r.resource_id, actorId: s.user_id,
        payload: { request_id: body.request_id, action: r.action, fields },
      });
    } else {
      return NextResponse.json({ error: `unsupported resource_type: ${r.resource_type}` }, { status: 400 });
    }

    await rows("provider", `
      UPDATE maker_checker_requests
         SET status='APPROVED', checker_id=$1, checker_email=$2,
             decision_notes=$3, decided_at=now()
       WHERE request_id=$4::uuid
    `, [s.user_id, s.email, body.notes ?? null, body.request_id]);

    await publish({
      eventType: "maker_checker.decided", producer: "provider_mgmt",
      entityType: r.resource_type, entityId: r.resource_id, actorId: s.user_id,
      payload: { request_id: body.request_id, decision: "APPROVED", action: r.action },
    });

    return NextResponse.json({ ok: true, decision: "APPROVED", applied });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
