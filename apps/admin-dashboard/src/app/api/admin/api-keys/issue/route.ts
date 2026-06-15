// POST /api/admin/api-keys/issue — generates a one-time secret.
// Per §3.11 matrix: Super Admin C R U D; Provider C R own; Merchant C R own.

import { NextResponse } from "next/server";
import { z } from "zod";
import { randomBytes } from "crypto";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

const schema = z.object({
  label: z.string().min(1).max(120),
  scopes: z.array(z.string()).default([]),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;

  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  const ownerKind = s.persona === "SUPER_ADMIN" ? "PLATFORM" : s.persona;
  const ownerId = s.scope_id ?? s.user_id;
  const secret = `sk_${randomBytes(24).toString("base64url")}`;
  const prefix = secret.slice(0, 10);
  // We never store the raw secret — only a SHA-256 hash. Caller sees it once.
  const { createHash } = await import("crypto");
  const hash = createHash("sha256").update(secret).digest("hex");

  try {
    const res = await rows<any>("auth", `
      INSERT INTO api_keys (tenant_id, owner_kind, owner_id, label, prefix, secret_hash, scopes, status, issued_by)
      VALUES ('tenant-default', $1, $2, $3, $4, $5, $6::text[], 'ACTIVE', $7)
      RETURNING id, label, owner_kind, owner_id, prefix, scopes, status, created_at
    `, [ownerKind, ownerId, body.label, prefix, hash, body.scopes, s.user_id]);
    return NextResponse.json({ key: res[0], secret });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
