// GET    /api/admin/webhooks — outbox + DLQ + recent + configs.
// POST   /api/admin/webhooks — create / upsert a merchant_webhook_config
//                              with auto-generated signing secret.
// PATCH  /api/admin/webhooks?config_id=… — toggle enabled / rotate URL.
// DELETE /api/admin/webhooks?config_id=… — remove a config row.

import { NextResponse } from "next/server";
import { z } from "zod";
import { randomBytes } from "crypto";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { wormAppend } from "@/lib/worm";

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

const createSchema = z.object({
  merchant_id: z.string().min(1).max(120),
  target_url:  z.string().url(),
  enabled:     z.boolean().optional().default(true),
  // event filter is informational today (the outbox dispatcher reads all events
  // per merchant); kept here for forward-compat with per-event subscriptions.
  events:      z.array(z.string()).optional(),
  remarks:     z.string().optional(),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;
  let body;
  try { body = createSchema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  const secret = randomBytes(24).toString("base64url");
  try {
    const r = await rows<{ config_id: string; merchant_id: string; target_url: string; enabled: boolean }>(
      "notification",
      `INSERT INTO merchant_webhook_configs (merchant_id, target_url, secret, enabled)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (merchant_id) DO UPDATE SET
         target_url = EXCLUDED.target_url,
         enabled    = EXCLUDED.enabled,
         updated_at = now()
       RETURNING config_id::text, merchant_id, target_url, enabled`,
      [body.merchant_id, body.target_url, secret, body.enabled ?? true],
    );
    await wormAppend({
      actorId: s.user_id, actorEmail: s.email,
      action: "webhook.config.upsert",
      resourceType: "webhook_config", resourceId: r[0].config_id,
      after: { merchant_id: body.merchant_id, target_url: body.target_url, enabled: body.enabled, events: body.events ?? ["*"] },
      notes: body.remarks,
    }).catch(() => null);
    // Secret is shown ONCE so the merchant can configure signature verification.
    return NextResponse.json({ ...r[0], secret });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const patchSchema = z.object({ target_url: z.string().url().optional(), enabled: z.boolean().optional() });

export async function PATCH(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const id = new URL(req.url).searchParams.get("config_id");
  if (!id) return NextResponse.json({ error: "config_id required" }, { status: 400 });
  let body;
  try { body = patchSchema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  const sets: string[] = [];
  const args: unknown[] = [];
  let i = 1;
  if (body.target_url !== undefined) { sets.push(`target_url = $${i++}`); args.push(body.target_url); }
  if (body.enabled    !== undefined) { sets.push(`enabled = $${i++}`);    args.push(body.enabled); }
  if (!sets.length) return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  sets.push(`updated_at = now()`);
  args.push(id);
  try {
    const r = await rows<any>("notification",
      `UPDATE merchant_webhook_configs SET ${sets.join(", ")} WHERE config_id = $${i}::uuid
       RETURNING config_id::text, merchant_id, target_url, enabled, updated_at`, args);
    if (!r.length) return NextResponse.json({ error: "not found" }, { status: 404 });
    await wormAppend({
      actorId: s.user_id, actorEmail: s.email,
      action: "webhook.config.update", resourceType: "webhook_config", resourceId: id, after: r[0],
    }).catch(() => null);
    return NextResponse.json(r[0]);
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

export async function DELETE(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const id = new URL(req.url).searchParams.get("config_id");
  if (!id) return NextResponse.json({ error: "config_id required" }, { status: 400 });
  try {
    const r = await rows<any>("notification",
      `DELETE FROM merchant_webhook_configs WHERE config_id = $1::uuid
       RETURNING config_id::text, merchant_id`, [id]);
    if (!r.length) return NextResponse.json({ error: "not found" }, { status: 404 });
    await wormAppend({
      actorId: s.user_id, actorEmail: s.email,
      action: "webhook.config.delete", resourceType: "webhook_config", resourceId: id, before: r[0],
    }).catch(() => null);
    return NextResponse.json({ ok: true });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
