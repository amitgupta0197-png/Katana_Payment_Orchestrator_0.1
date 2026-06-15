// Persona policy (PRODUCT_VISION §3.7):
//   SUPER_ADMIN — C via sync, R ✓, U match_status only.
//   PROVIDER    — R own only.
//   MERCHANT    — R own only.

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
      if (!ids.length) return NextResponse.json({ records: [] });
      where += ` AND merchant_id = ANY($${params.length + 1}::text[])`;
      params.push(ids);
    }
    const records = await rows<any>("reconciliation", `
      SELECT id, tenant_id, merchant_id, partner_kind, partner,
             COALESCE(utr,'') AS utr, COALESCE(payout_ref,'') AS payout_ref,
             COALESCE(txid,'') AS txid, amount, currency, match_status, synced_at
        FROM settlement_partner_records
       WHERE ${where}
       ORDER BY synced_at DESC LIMIT 200
    `, params).catch(() => []);
    return NextResponse.json({ records });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
