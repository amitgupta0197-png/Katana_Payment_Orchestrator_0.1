// GET  /api/admin/credentials — list vault entries (no plaintext exposed).
// POST /api/admin/credentials — store a credential.
//
// Plaintext leaves the server only via signed/audited routes (none in Sprint 5);
// the admin UI can read names and rotation status but not values.

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { storeCredential, listCredentials, readCredential } from "@/lib/credential-vault";
import { wormAppend } from "@/lib/worm";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const url = new URL(req.url);
  try {
    const credentials = await listCredentials({
      ownerType: url.searchParams.get("owner_type") ?? undefined,
      ownerId:   url.searchParams.get("owner_id")   ?? undefined,
    });
    return NextResponse.json({ credentials });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const schema = z.object({
  kind: z.enum(["vendor_secret","mid_secret","webhook_secret","bank_key"]),
  owner_type: z.enum(["vendor","merchant","provider","tenant"]),
  owner_id: z.string().min(1),
  label: z.string().min(1).max(120),
  plaintext: z.string().min(1).max(8192),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const credential_id = await storeCredential({
      kind: body.kind, ownerType: body.owner_type,
      ownerId: body.owner_id, label: body.label, plaintext: body.plaintext,
    });
    // Round-trip read as a self-check (proves seal/unseal works without leaking
    // the plaintext outside the server) — we just discard the result.
    await readCredential({
      kind: body.kind, ownerType: body.owner_type,
      ownerId: body.owner_id, label: body.label,
    });
    await wormAppend({
      actorId: s.user_id, actorEmail: s.email,
      action: "credential.stored",
      resourceType: "credential", resourceId: credential_id,
      before: null,
      after: { kind: body.kind, owner_type: body.owner_type, owner_id: body.owner_id, label: body.label },
    }).catch(() => null);
    return NextResponse.json({ credential_id });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
