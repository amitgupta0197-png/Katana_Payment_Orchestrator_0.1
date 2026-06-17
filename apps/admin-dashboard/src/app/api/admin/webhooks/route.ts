// GET /api/admin/webhooks — outbox listing for the admin queue/DLQ view.
//
// Returns three buckets: due/pending, retrying, dead-lettered.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  try {
    const pending = await rows<any>("notification", `
      SELECT outbox_id::text, merchant_id, order_id::text, event_type, target_url,
             status, attempts, COALESCE(last_error,'') AS last_error,
             next_attempt_at, created_at, payload
        FROM webhook_outbox
       WHERE status='PENDING'
       ORDER BY next_attempt_at ASC LIMIT 200
    `);
    const dlq = await rows<any>("notification", `
      SELECT outbox_id::text, merchant_id, order_id::text, event_type, target_url,
             status, attempts, COALESCE(last_error,'') AS last_error,
             next_attempt_at, dead_lettered_at, created_at, payload
        FROM webhook_outbox
       WHERE status='DEAD_LETTER'
       ORDER BY dead_lettered_at DESC LIMIT 200
    `);
    const recent = await rows<any>("notification", `
      SELECT outbox_id::text, merchant_id, order_id::text, event_type, target_url,
             status, attempts, delivered_at, created_at
        FROM webhook_outbox
       WHERE status='DELIVERED'
       ORDER BY delivered_at DESC LIMIT 50
    `);
    const configs = await rows<any>("notification", `
      SELECT config_id::text, merchant_id, target_url, enabled, updated_at
        FROM merchant_webhook_configs
       ORDER BY merchant_id
    `);
    return NextResponse.json({ pending, dlq, recent, configs });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
