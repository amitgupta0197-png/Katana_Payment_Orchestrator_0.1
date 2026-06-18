// POST /api/merchants/[id]/api-keys/issue — issue an API key for a specific merchant.
// Returns the raw secret ONCE; only a SHA-256 hash is stored. Mirrors
// api/admin/api-keys/issue but binds owner_kind='MERCHANT', owner_id=merchant_code.

import { NextResponse } from "next/server";
import { z } from "zod";
import { randomBytes, createHash } from "crypto";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { resolveMerchantScope } from "@/lib/merchant-keys";

export const dynamic = "force-dynamic";

const schema = z.object({
  label: z.string().min(1).max(120).optional(),
  scopes: z.array(z.string()).default([]),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;

  const scope = await resolveMerchantScope(id, s);
  if ("response" in scope) return scope.response;

  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  const label = body.label?.trim() || `${scope.code} key`;
  const secret = `sk_${randomBytes(24).toString("base64url")}`;
  const prefix = secret.slice(0, 10);
  const hash = createHash("sha256").update(secret).digest("hex");

  try {
    const res = await rows<any>("auth", `
      INSERT INTO api_keys (tenant_id, owner_kind, owner_id, label, prefix, secret_hash, scopes, status, issued_by)
      VALUES ('tenant-default', 'MERCHANT', $1, $2, $3, $4, $5::text[], 'ACTIVE', $6)
      RETURNING id, label, owner_kind, owner_id, prefix, scopes, status, created_at
    `, [scope.code, label, prefix, hash, body.scopes, s.user_id]);
    return NextResponse.json({ key: res[0], secret });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
