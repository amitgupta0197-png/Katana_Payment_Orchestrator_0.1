// GET   /api/admin/webhooks/[id] — outbox row + attempt history
// POST  /api/admin/webhooks/[id]?action=retry — bump next_attempt_at to now
// POST  /api/admin/webhooks/[id]?action=discard — mark DEAD_LETTER manually

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { wormAppend } from "@/lib/worm";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  try {
    const ob = await rows<any>("notification", `
      SELECT outbox_id::text, merchant_id, order_id::text, event_type, target_url,
             status, attempts, COALESCE(last_error,'') AS last_error,
             next_attempt_at, delivered_at, dead_lettered_at, created_at, payload
        FROM webhook_outbox WHERE outbox_id = $1::uuid
    `, [id]);
    if (!ob.length) return NextResponse.json({ error: "not found" }, { status: 404 });
    const attempts = await rows<any>("notification", `
      SELECT attempt_id::text, attempt_no, target_url, response_status,
             COALESCE(response_body,'') AS response_body,
             COALESCE(error,'') AS error, duration_ms,
             signature, timestamp_sent, attempted_at
        FROM webhook_dispatch_attempts WHERE outbox_id = $1::uuid
        ORDER BY attempt_no
    `, [id]);
    return NextResponse.json({ outbox: ob[0], attempts });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;
  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  try {
    const ob = await rows<any>("notification",
      "SELECT outbox_id::text, merchant_id, status FROM webhook_outbox WHERE outbox_id = $1::uuid", [id]);
    if (!ob.length) return NextResponse.json({ error: "not found" }, { status: 404 });

    if (action === "retry") {
      const r = await rows<any>("notification", `
        UPDATE webhook_outbox
           SET status='PENDING', next_attempt_at=now(), last_error=NULL
         WHERE outbox_id=$1::uuid
         RETURNING outbox_id::text, status, attempts
      `, [id]);
      await wormAppend({
        actorId: s.user_id, actorEmail: s.email,
        action: "webhook.retry", resourceType: "webhook_outbox", resourceId: id,
        before: { status: ob[0].status }, after: { status: "PENDING" },
        notes: `manual retry for merchant ${ob[0].merchant_id}`,
      }).catch(() => null);
      return NextResponse.json({ ok: true, ...r[0] });
    }
    if (action === "discard") {
      const r = await rows<any>("notification", `
        UPDATE webhook_outbox
           SET status='DEAD_LETTER', dead_lettered_at=now(),
               last_error='manually discarded by admin'
         WHERE outbox_id=$1::uuid
         RETURNING outbox_id::text, status, attempts
      `, [id]);
      await wormAppend({
        actorId: s.user_id, actorEmail: s.email,
        action: "webhook.discard", resourceType: "webhook_outbox", resourceId: id,
        before: { status: ob[0].status }, after: { status: "DEAD_LETTER" },
      }).catch(() => null);
      return NextResponse.json({ ok: true, ...r[0] });
    }
    return NextResponse.json({ error: "unknown action; use ?action=retry or ?action=discard" }, { status: 400 });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
