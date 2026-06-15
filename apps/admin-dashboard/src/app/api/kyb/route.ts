// Persona policy (PRODUCT_VISION §3.10):
//   SUPER_ADMIN — C ✓ R ✓ U ✓.
//   PROVIDER    — C open case for mapped merchant; R own.
//   MERCHANT    — R own.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse, resolveProviderMerchants } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;

  try {
    const params: unknown[] = ["tenant-default"];
    let where = "tenant_id = $1";
    if (s.persona === "MERCHANT") {
      where += ` AND merchant_id = $${params.length + 1}`;
      params.push(s.scope_id);
    } else if (s.persona === "PROVIDER") {
      const ids = await resolveProviderMerchants(s);
      if (!ids.length) return NextResponse.json({ cases: [] });
      where += ` AND merchant_id = ANY($${params.length + 1}::text[])`;
      params.push(ids);
    }
    const cases = await rows<any>("kybPayments", `
      SELECT id, tenant_id, merchant_id, status, risk_tier, opened_at, decided_at,
             COALESCE(decided_by,'') AS decided_by, screening_hits, doc_count
        FROM kyb_cases
       WHERE ${where}
       ORDER BY opened_at DESC LIMIT 200
    `, params).catch(() => []);
    return NextResponse.json({ cases });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
