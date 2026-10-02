// API keys for the v2 order API (lib/v2-keys).
//   GET    /api/portal/keys?merchant_code=…                    the banker's keys (prefix only)
//   POST   /api/portal/keys { merchant_code, livemode, label } a new key; the secret is in the answer, once
//   DELETE /api/portal/keys?merchant_code=…&id=…               revoke one

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { PORTAL_PERSONAS, inScope, portalScope } from "@/lib/portal-scope";
import { issueV2Key, listV2Keys, revokeV2Key } from "@/lib/v2-keys";
import { activationErrorResponse } from "@/lib/live-activation";
import { wormAppend } from "@/lib/worm";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(PORTAL_PERSONAS);
  if ("response" in g) return g.response;
  const code = new URL(req.url).searchParams.get("merchant_code") ?? "";
  try {
    if (!inScope(await portalScope(g.session), code)) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ keys: await listV2Keys(code) });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const schema = z.object({
  merchant_code: z.string().min(1).max(120),
  livemode: z.boolean(),
  label: z.string().max(120).default(""),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(PORTAL_PERSONAS);
  if ("response" in g) return g.response;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    if (!inScope(await portalScope(g.session), body.merchant_code)) return NextResponse.json({ error: "not found" }, { status: 404 });
    const r = await issueV2Key(body.merchant_code, body.livemode, body.label, g.session.email);
    await wormAppend({
      actorId: g.session.user_id, actorEmail: g.session.email, action: "api_key.issue",
      resourceType: "merchant", resourceId: body.merchant_code, after: { key_id: r.key.id, prefix: r.key.prefix, livemode: r.key.livemode },
    }).catch(() => null);
    return NextResponse.json(r, { status: 201 });
  } catch (err) {
    const a = activationErrorResponse(err);   // a live key before live mode is activated
    if (a) return NextResponse.json(a.body, { status: a.status });
    const e = pgError(err); return NextResponse.json(e.body, { status: e.status });
  }
}

export async function DELETE(req: Request) {
  const g = await gateOrResponse(PORTAL_PERSONAS);
  if ("response" in g) return g.response;
  const p = new URL(req.url).searchParams;
  const code = p.get("merchant_code") ?? "", id = p.get("id") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "id required" }, { status: 400 });
  try {
    if (!inScope(await portalScope(g.session), code)) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (!(await revokeV2Key(code, id))) return NextResponse.json({ error: "not found" }, { status: 404 });
    await wormAppend({
      actorId: g.session.user_id, actorEmail: g.session.email, action: "api_key.revoke",
      resourceType: "merchant", resourceId: code, after: { key_id: id },
    }).catch(() => null);
    return NextResponse.json({ ok: true });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
