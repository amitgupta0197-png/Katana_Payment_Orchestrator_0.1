// SUPER_ADMIN CRUD; PROVIDER R U mapped; MERCHANT R own (PRODUCT_VISION §3.11).
// Reads feature_flag overrides + per-merchant settings from configservice_db.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse, resolveProviderMerchants } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;
  try {
    const params: unknown[] = [];
    let where = "TRUE";
    if (s.persona === "MERCHANT") { where = `scope_kind = 'MERCHANT' AND scope_value = $${params.length + 1}`; params.push(s.scope_id); }
    else if (s.persona === "PROVIDER") {
      const ids = await resolveProviderMerchants(s);
      if (!ids.length) return NextResponse.json({ flags: [], overrides: [] });
      where = `scope_kind = 'MERCHANT' AND scope_value = ANY($${params.length + 1}::text[])`; params.push(ids);
    }
    const flags = await rows<any>("config", `
      SELECT key, description, kind, default_value, archived, created_at
        FROM feature_flags WHERE archived = false ORDER BY key LIMIT 200
    `).catch(() => []);
    const overrides = await rows<any>("config", `
      SELECT id::text, flag_key, scope_kind, scope_value, value, created_at
        FROM feature_flag_overrides
       WHERE ${where}
       ORDER BY created_at DESC LIMIT 200
    `, params).catch(() => []);
    return NextResponse.json({ flags, overrides });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
