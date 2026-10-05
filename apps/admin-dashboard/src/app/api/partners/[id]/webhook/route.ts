// A partner's webhook (lib/partner/callback): where its orders' events go, which events, and the
// signing secret (sealed; shown once when made).
//
//   GET  /api/partners/{id}/webhook       URL, events, whether a secret is set, the last deliveries
//   PUT  /api/partners/{id}/webhook       { url?, events? }
//   POST /api/partners/{id}/webhook       { rotate: true } → { secret } (the old one stops working)
//
// The partner itself and Super Admin / Admin.

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError, rows } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { actorOf, can, forbidden, notFound, PARTNER_READERS, partnerInScope } from "@/lib/partner/access";
import { PARTNER_OUTBOX_PREFIX } from "@/lib/partner/rules";
import { rotatePartnerSecret, setPartnerWebhook } from "@/lib/partner/store";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const g = await gateOrResponse([...PARTNER_READERS]);
  if ("response" in g) return g.response;
  try {
    const p = await partnerInScope(g.session, (await params).id);
    if (!p) return notFound();
    const deliveries = await rows("notification", `
      SELECT outbox_id::text, order_id::text, event_type, event_id, target_url, status, attempts, last_error, livemode, created_at, delivered_at
        FROM webhook_outbox WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 30
    `, [`${PARTNER_OUTBOX_PREFIX}${p.id}`]).catch(() => []);
    return NextResponse.json({
      url: p.webhook_url, events: p.webhook_events, has_secret: p.has_webhook_secret, can_manage: can.keys(g.session), deliveries,
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const putSchema = z.object({
  url: z.string().url().refine((u) => /^https:\/\//i.test(u) || process.env.NODE_ENV !== "production", "the webhook URL must be https").nullable().optional(),
  events: z.enum(["ALL", "PAID_ONLY"]).optional(),
}).strict();

export async function PUT(req: Request, { params }: Ctx) {
  const g = await gateOrResponse([...PARTNER_READERS]);
  if ("response" in g) return g.response;
  if (!can.keys(g.session)) return forbidden("change the webhook");
  const b = putSchema.safeParse(await req.json().catch(() => null));
  if (!b.success) return NextResponse.json({ error: b.error.issues[0].message }, { status: 400 });
  try {
    const p = await partnerInScope(g.session, (await params).id);
    if (!p) return notFound();
    const r = await setPartnerWebhook(p.id, b.data, actorOf(g.session, p));
    return NextResponse.json({ url: r?.webhook_url ?? null, events: r?.webhook_events ?? "ALL", has_secret: r?.has_webhook_secret ?? false });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

export async function POST(req: Request, { params }: Ctx) {
  const g = await gateOrResponse([...PARTNER_READERS]);
  if ("response" in g) return g.response;
  if (!can.keys(g.session)) return forbidden("make a signing secret");
  const b = z.object({ rotate: z.literal(true) }).safeParse(await req.json().catch(() => null));
  if (!b.success) return NextResponse.json({ error: "send { rotate: true }" }, { status: 400 });
  try {
    const p = await partnerInScope(g.session, (await params).id);
    if (!p) return notFound();
    const secret = await rotatePartnerSecret(p.id, actorOf(g.session, p));
    return secret ? NextResponse.json({ secret }) : notFound();
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
