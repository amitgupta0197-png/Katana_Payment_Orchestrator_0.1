// GET /api/v1/queue — the FIFO queue for operators/admins (BRD §15/§16).
// Shows QUEUED head-of-line first, then the caller's in-flight assignments.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { operatorForUser } from "@/lib/fifo";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["OPERATOR", "SUPER_ADMIN", "ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const url = new URL(req.url);
  const mine = url.searchParams.get("mine") === "1";

  try {
    const opId = await operatorForUser(s.email, s.full_name, s.user_id);
    const params: unknown[] = [];
    let where = "q.status IN ('QUEUED','ASSIGNED','ACCEPTED')";
    if (mine && opId) { where += ` AND q.assigned_to = $${params.length + 1}::uuid`; params.push(opId); }

    const items = await rows<any>("fifo", `
      SELECT q.id::text AS queue_id, q.order_id::text, q.priority, q.status AS queue_status,
             q.enqueued_at, q.assigned_to::text, q.assigned_at, q.accepted_at, q.sla_due_at, q.reassign_count,
             o.order_ref, o.merchant_id, o.direction, o.amount_minor::text, o.currency,
             o.settlement_mode, o.status AS order_status, o.risk_score, o.risk_decision, o.customer_name
        FROM fifo_queue q JOIN fifo_orders o ON o.id = q.order_id
       WHERE ${where}
       ORDER BY q.priority DESC, q.enqueued_at ASC
       LIMIT 200
    `, params);

    return NextResponse.json({ operator_id: opId, items });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
