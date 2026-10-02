// Webhook settings of the bankers in scope (lib/webhook-settings).
//   GET   /api/portal/webhooks/settings                 each banker's version, events, callback URL
//   PATCH /api/portal/webhooks/settings { merchant_code, webhook_version?, webhook_events?, callback_url? }
// Moving a banker to v2 makes its signing secret when it has none; the answer carries it once.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { PORTAL_PERSONAS, inScope, portalScope } from "@/lib/portal-scope";
import { listWebhookSettings, saveWebhookSettings } from "@/lib/webhook-settings";
import { wormAppend } from "@/lib/worm";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(PORTAL_PERSONAS);
  if ("response" in g) return g.response;
  try {
    const scope = await portalScope(g.session);
    // Staff name the banker they are looking at; a merchant gets its own.
    const one = new URL(req.url).searchParams.get("merchant_code")?.trim();
    const codes = scope.codes ?? (one ? [one] : (await rows<{ merchant_code: string }>("merchant",
      `SELECT merchant_code FROM merchants ORDER BY merchant_code LIMIT 500`)).map((m) => m.merchant_code));
    return NextResponse.json({ settings: await listWebhookSettings(one && scope.codes ? codes.filter((c) => c === one) : codes) });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const schema = z.object({
  merchant_code: z.string().min(1).max(120),
  webhook_version: z.enum(["v1", "v2"]).optional(),
  webhook_events: z.enum(["ALL", "PAID_ONLY"]).optional(),
  callback_url: z.string().max(500).optional(),
});

export async function PATCH(req: Request) {
  const g = await gateOrResponse(PORTAL_PERSONAS);
  if ("response" in g) return g.response;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const scope = await portalScope(g.session);
    if (!inScope(scope, body.merchant_code)) return NextResponse.json({ error: "not found" }, { status: 404 });
    const { merchant_code, ...change } = body;
    const r = await saveWebhookSettings(merchant_code, change, g.session.email);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
    await wormAppend({
      actorId: g.session.user_id, actorEmail: g.session.email, action: "webhook.settings.update",
      resourceType: "merchant", resourceId: merchant_code,
      after: { webhook_version: r.settings.webhook_version, webhook_events: r.settings.webhook_events, callback_url: r.settings.callback_url, secret_created: !!r.secret },
    }).catch(() => null);
    return NextResponse.json({ settings: r.settings, ...(r.secret ? { secret: r.secret } : {}) });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
