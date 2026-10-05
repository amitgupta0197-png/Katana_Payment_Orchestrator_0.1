// A partner's API keys (lib/partner/keys): pk_live_… / pk_test_…, shown once when made.
//
//   GET    /api/partners/{id}/keys                 the keys (prefix, mode, last used)
//   POST   /api/partners/{id}/keys                 { livemode, label? } → { key, secret }
//   DELETE /api/partners/{id}/keys?key=<key id>    revoke one
//
// The partner itself and Super Admin / Admin.

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { actorOf, can, forbidden, notFound, PARTNER_READERS, partnerInScope } from "@/lib/partner/access";
import { issuePartnerKey, listPartnerKeys, revokePartnerKey } from "@/lib/partner/keys";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const g = await gateOrResponse([...PARTNER_READERS]);
  if ("response" in g) return g.response;
  try {
    const p = await partnerInScope(g.session, (await params).id);
    if (!p) return notFound();
    return NextResponse.json({ keys: await listPartnerKeys(p.id), can_manage: can.keys(g.session) });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const issueSchema = z.object({ livemode: z.boolean(), label: z.string().max(120).optional() });

export async function POST(req: Request, { params }: Ctx) {
  const g = await gateOrResponse([...PARTNER_READERS]);
  if ("response" in g) return g.response;
  if (!can.keys(g.session)) return forbidden("make partner API keys");
  const b = issueSchema.safeParse(await req.json().catch(() => null));
  if (!b.success) return NextResponse.json({ error: b.error.issues[0].message }, { status: 400 });
  try {
    const p = await partnerInScope(g.session, (await params).id);
    if (!p) return notFound();
    if (p.status !== "ACTIVE") return NextResponse.json({ error: "the partner is suspended" }, { status: 409 });
    return NextResponse.json(await issuePartnerKey(p.id, b.data.livemode, b.data.label ?? "", actorOf(g.session, p)), { status: 201 });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

export async function DELETE(req: Request, { params }: Ctx) {
  const g = await gateOrResponse([...PARTNER_READERS]);
  if ("response" in g) return g.response;
  if (!can.keys(g.session)) return forbidden("revoke partner API keys");
  try {
    const p = await partnerInScope(g.session, (await params).id);
    if (!p) return notFound();
    const keyId = new URL(req.url).searchParams.get("key") ?? "";
    if (!/^[0-9a-f-]{36}$/i.test(keyId)) return NextResponse.json({ error: "key is required" }, { status: 400 });
    const ok = await revokePartnerKey(p.id, keyId, actorOf(g.session, p));
    return ok ? NextResponse.json({ revoked: true }) : notFound();
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
