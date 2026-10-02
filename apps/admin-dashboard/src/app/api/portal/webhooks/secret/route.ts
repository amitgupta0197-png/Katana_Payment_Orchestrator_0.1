// POST /api/portal/webhooks/secret { merchant_code } — replace a banker's v2 webhook signing
// secret. The new one is in the answer, once; the old one stops verifying at once.

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { PORTAL_PERSONAS, inScope, portalScope } from "@/lib/portal-scope";
import { rotateWebhookSecret } from "@/lib/webhook-settings";
import { wormAppend } from "@/lib/worm";

export const dynamic = "force-dynamic";

const schema = z.object({ merchant_code: z.string().min(1).max(120) });

export async function POST(req: Request) {
  const g = await gateOrResponse(PORTAL_PERSONAS);
  if ("response" in g) return g.response;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    if (!inScope(await portalScope(g.session), body.merchant_code)) return NextResponse.json({ error: "not found" }, { status: 404 });
    const secret = await rotateWebhookSecret(body.merchant_code);
    if (!secret) return NextResponse.json({ error: "not found" }, { status: 404 });
    await wormAppend({
      actorId: g.session.user_id, actorEmail: g.session.email, action: "webhook.secret.rotate",
      resourceType: "merchant", resourceId: body.merchant_code,
    }).catch(() => null);
    return NextResponse.json({ secret });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
