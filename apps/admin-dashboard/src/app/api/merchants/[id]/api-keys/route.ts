// Merchant-scoped API keys.
//   GET  /api/merchants/[id]/api-keys        — list keys issued for this merchant (prefixes only).
//   POST /api/merchants/[id]/api-keys/issue   — see ./issue/route.ts (returns the secret once).
//
// SUPER_ADMIN may manage any merchant's keys; PROVIDER only merchants mapped to them.
// Keys are owned by owner_kind='MERCHANT', owner_id=merchant_code (see api/admin/api-keys).

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { resolveMerchantScope } from "@/lib/merchant-keys";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const { id } = await params;

  const scope = await resolveMerchantScope(id, g.session);
  if ("response" in scope) return scope.response;

  try {
    const keys = await rows<any>("auth", `
      SELECT id, label, prefix, scopes, status, created_at, last_used_at, revoked_at
        FROM api_keys
       WHERE tenant_id = 'tenant-default' AND owner_kind = 'MERCHANT' AND owner_id = $1
       ORDER BY created_at DESC LIMIT 200
    `, [scope.code]);
    return NextResponse.json({ keys });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
