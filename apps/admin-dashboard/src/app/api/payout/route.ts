// Persona policy (PRODUCT_VISION §3.11):
//   SUPER_ADMIN — C ✓ R ✓ U ✓ (trigger).
//   PROVIDER    — C ✓ for mapped, R ✓ for mapped.
//   MERCHANT    — C ✓ for own (rate-limited), R ✓ own.

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
      if (!ids.length) return NextResponse.json({ payouts: [] });
      where += ` AND merchant_id = ANY($${params.length + 1}::text[])`;
      params.push(ids);
    }
    const payouts = await rows<any>("payout", `
      SELECT id, tenant_id, merchant_id, payout_ref, beneficiary_vpa, beneficiary_ifsc,
             amount, currency, status, requested_at, dispatched_at, completed_at
        FROM payout_requests
       WHERE ${where}
       ORDER BY requested_at DESC LIMIT 200
    `, params).catch(() => []);
    return NextResponse.json({ payouts });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
