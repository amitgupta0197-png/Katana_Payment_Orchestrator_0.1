// Persona policy (PRODUCT_VISION §3.11):
//   SUPER_ADMIN — C R U D.
//   PROVIDER    — C R own.
//   MERCHANT    — C R own.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;

  try {
    const params: unknown[] = ["tenant-default"];
    let where = "tenant_id = $1";
    if (s.persona === "PROVIDER") {
      where += ` AND owner_kind = 'PROVIDER' AND owner_id = $${params.length + 1}`;
      params.push(s.scope_id);
    } else if (s.persona === "MERCHANT") {
      where += ` AND owner_kind = 'MERCHANT' AND owner_id = $${params.length + 1}`;
      params.push(s.scope_id);
    }
    const keys = await rows<any>("auth", `
      SELECT id, label, owner_kind, owner_id, prefix, scopes, status,
             created_at, last_used_at, revoked_at
        FROM api_keys
       WHERE ${where}
       ORDER BY created_at DESC LIMIT 200
    `, params);
    return NextResponse.json({ keys });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
