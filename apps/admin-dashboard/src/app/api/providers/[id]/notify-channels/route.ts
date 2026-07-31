// /api/providers/[id]/notify-channels — external settlement notification channels
// (BRD §7). GET list / POST add / DELETE remove (?channel=<id>).
//   SUPER_ADMIN + PROVIDER(own). WEBHOOK fires live (signed); EMAIL stored but dormant
//   until SMTP is configured on the server.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

function scopeDenied(session: { persona: string; scope_id: string | null }, id: string): NextResponse | null {
  if (session.persona === "PROVIDER" && session.scope_id !== id)
    return NextResponse.json({ error: "providers can only manage their own channels" }, { status: 403 });
  return null;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  const denied = scopeDenied(g.session, id);
  if (denied) return denied;
  try {
    const channels = await rows("provider", `
      SELECT id::text, kind, target, enabled, created_by, created_at
        FROM provider_notification_channels WHERE provider_id = $1::uuid ORDER BY created_at DESC
    `, [id]);
    return NextResponse.json({ channels });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const createSchema = z.object({
  kind: z.enum(["WEBHOOK", "EMAIL"]),
  target: z.string().min(5).max(500),
}).refine((b) => b.kind !== "WEBHOOK" || /^https?:\/\//.test(b.target), { message: "webhook target must be an http(s) URL" })
  .refine((b) => b.kind !== "EMAIL" || /.+@.+\..+/.test(b.target), { message: "email target must be a valid address" });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;
  const denied = scopeDenied(s, id);
  if (denied) return denied;

  let body: z.infer<typeof createSchema>;
  try { body = createSchema.parse(await req.json()); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }

  try {
    const ins = await rows<{ id: string }>("provider", `
      INSERT INTO provider_notification_channels (provider_id, kind, target, created_by)
      VALUES ($1::uuid, $2, $3, $4)
      ON CONFLICT (provider_id, kind, target) DO UPDATE SET enabled = true
      RETURNING id::text
    `, [id, body.kind, body.target.trim(), s.email]);
    return NextResponse.json({ channel_id: ins[0].id });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  const denied = scopeDenied(g.session, id);
  if (denied) return denied;
  const channelId = new URL(req.url).searchParams.get("channel");
  if (!channelId) return NextResponse.json({ error: "channel id required" }, { status: 400 });
  try {
    await rows("provider", `
      DELETE FROM provider_notification_channels WHERE id = $1::uuid AND provider_id = $2::uuid
    `, [channelId, id]);
    return NextResponse.json({ ok: true });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
