// Provider PoolPay (Katana Pay) integration config.
//   GET  — read the provider's integration config (NEVER returns secrets, only
//          secret_set / apikey_set flags).
//   PUT  — admin upserts the config (base URL, pay id, return/callback URLs,
//          env, enabled) and optionally the SECRET_KEY / API key (vaulted).
//
//   SUPER_ADMIN: full read + write.
//   PROVIDER:    read own only (so the provider can see what's wired but not edit
//                or read the secret).
//
// Configuring this on a provider cascades to every merchant (branch) mapped under
// it — see resolvePoolPayConfig() in lib/provider-integration.ts.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { publish } from "@/lib/events";
import { getProviderIntegration, setProviderIntegration } from "@/lib/provider-integration";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;
  if (s.persona === "PROVIDER" && s.scope_id !== id)
    return NextResponse.json({ error: "providers can only read own integration" }, { status: 403 });

  try {
    const cfg = await getProviderIntegration(id);
    // Default shape so the form renders even before first save.
    return NextResponse.json({
      integration: cfg ?? {
        provider_id: id, vendor: "POOLPAY", enabled: false, env: "SANDBOX",
        base_url: null, pay_id: null, client_id: null, return_url: null, callback_url: null,
        secret_set: false, apikey_set: false, config: {}, updated_by: null, updated_at: null,
      },
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const putSchema = z.object({
  enabled: z.boolean().optional(),
  env: z.enum(["SANDBOX", "PROD"]).optional(),
  base_url: z.string().url().max(1024).nullable().optional(),
  pay_id: z.string().max(120).nullable().optional(),
  client_id: z.string().max(200).nullable().optional(),
  return_url: z.string().url().max(1024).nullable().optional(),
  callback_url: z.string().url().max(1024).nullable().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  secret: z.string().max(512).optional(),   // SECRET_KEY for the SHA256 hash
  api_key: z.string().max(512).optional(),  // bearer / x-api-key
}).strict();

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;

  let body;
  try { body = putSchema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  // Provider must exist.
  const exists = await rows<{ id: string }>("provider",
    `SELECT id::text FROM providers WHERE id = $1::uuid`, [id]).catch(() => []);
  if (!exists.length) return NextResponse.json({ error: "provider not found" }, { status: 404 });

  // Going live needs the pieces to sign + route, or every branch order would fail.
  if (body.enabled && body.env === "PROD") {
    const existing = await getProviderIntegration(id);
    const baseUrl = body.base_url ?? existing?.base_url;
    const hasSecret = (typeof body.secret === "string" && body.secret.length > 0) || existing?.secret_set;
    if (!baseUrl || !hasSecret)
      return NextResponse.json({ error: "PROD requires a base URL and a saved SECRET_KEY before enabling" }, { status: 400 });
  }

  try {
    const saved = await setProviderIntegration(id, body, s.email);
    await rows("provider", `
      INSERT INTO provider_audit_logs (provider_id, actor, action, payload)
      VALUES ($1::uuid, $2, $3, $4::jsonb)
    `, [id, s.email, "provider.integration.updated", JSON.stringify({
      vendor: "POOLPAY", enabled: saved.enabled, env: saved.env,
      base_url: saved.base_url, secret_rotated: typeof body.secret === "string" && body.secret.length > 0,
    })]).catch(() => {});
    await publish({
      eventType: "provider.integration.updated",
      producer: "provider_mgmt",
      entityType: "provider", entityId: id, actorId: s.user_id,
      payload: { vendor: "POOLPAY", enabled: saved.enabled, env: saved.env },
    }).catch(() => {});
    return NextResponse.json({ integration: saved });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
