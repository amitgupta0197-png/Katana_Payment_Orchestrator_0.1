// Persona policy (PRODUCT_VISION §3.11):
//   SUPER_ADMIN — C R U D.
//   PROVIDER    — R own commission rules.
//   MERCHANT    — ✗.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const s = g.session;

  try {
    const params: unknown[] = ["tenant-default"];
    let where = "tenant_id = $1";
    if (s.persona === "PROVIDER") {
      where += ` AND provider_id = $${params.length + 1}::uuid`;
      params.push(s.scope_id);
    }
    const rules = await rows<any>("commission", `
      SELECT id, tenant_id, provider_id::text AS provider_id, rule_kind, rate_bps, fixed_fee,
             currency, valid_from, valid_to, created_at
        FROM provider_commission_rules
       WHERE ${where}
       ORDER BY valid_from DESC LIMIT 200
    `, params).catch(() => []);
    return NextResponse.json({ rules, mtd_earned: 0, ytd_earned: 0 });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
