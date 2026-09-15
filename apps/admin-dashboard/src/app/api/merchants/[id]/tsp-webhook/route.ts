// A merchant's TSP webhook link (the one callback URL their payment gateway posts to).
//   GET  /api/merchants/[id]/tsp-webhook  — the link and whether a signing secret is issued.
//   POST /api/merchants/[id]/tsp-webhook  — generate/rotate the secret; returns it ONCE.
//
// SUPER_ADMIN any; PROVIDER only for mapped merchants (resolveMerchantScope). The link is
// assigned lazily here too, so merchants onboarded before migration 0008 still get one.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { resolveMerchantScope } from "@/lib/merchant-keys";
import { assignWebhookSlug, readWebhookSecret, rotateWebhookSecret, webhookUrl } from "@/lib/merchant-webhook";
import { activationErrorResponse } from "@/lib/live-activation";

export const dynamic = "force-dynamic";

async function linkFor(code: string) {
  const m = await rows<{ website: string | null }>("merchant", `SELECT website FROM merchants WHERE merchant_code = $1`, [code]);
  const slug = await assignWebhookSlug(code, m[0]?.website);
  return slug ? { slug, url: webhookUrl(slug) } : null;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  const scope = await resolveMerchantScope(id, g.session);
  if ("response" in scope) return scope.response;
  try {
    const link = await linkFor(scope.code);
    if (!link) return NextResponse.json({ error: "could not assign a webhook link" }, { status: 500 });
    const [secret, testSecret] = await Promise.all([
      readWebhookSecret(scope.code, true).catch(() => null),
      readWebhookSecret(scope.code, false).catch(() => null),
    ]);
    return NextResponse.json({ ...link, secret_configured: !!secret, test_secret_configured: !!testSecret });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  const scope = await resolveMerchantScope(id, g.session);
  if ("response" in scope) return scope.response;
  try {
    const link = await linkFor(scope.code);
    if (!link) return NextResponse.json({ error: "could not assign a webhook link" }, { status: 500 });
    // { livemode: false } rotates the TEST secret; anything else rotates the live one.
    const b = (await req.json().catch(() => ({}))) as { livemode?: unknown };
    const livemode = b.livemode !== false;
    const secret = await rotateWebhookSecret(scope.code, livemode);
    await rows("merchant", `
      INSERT INTO merchant_activity (merchant_id, action, actor, payload)
      VALUES ($1::uuid, 'TSP_WEBHOOK_SECRET_ROTATED', $2, $3::jsonb)
    `, [id, g.session.email, JSON.stringify({ url: link.url, livemode })]).catch(() => {});
    return NextResponse.json({ ...link, secret, livemode }, { status: 201 });
  } catch (err) {
    const a = activationErrorResponse(err);   // a live secret before live mode is activated
    if (a) return NextResponse.json(a.body, { status: a.status });
    const e = pgError(err); return NextResponse.json(e.body, { status: e.status });
  }
}
