// Persona policy (PRODUCT_VISION §3.11):
//   SUPER_ADMIN — C R U + trigger.
//   PROVIDER    — R mapped.
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
      if (!ids.length) return NextResponse.json({ batches: [] });
      where += ` AND merchant_id = ANY($${params.length + 1}::text[])`;
      params.push(ids);
    }
    // Aliases below match the column names the /settlement page renders.
    // SQL columns: batch_date / fees_amount / net_amount; client expects
    // period_start / period_end / fee_amount / net_payable. Keep both for
    // back-compat — drop the duplicates after the page stabilizes.
    const batches = await rows<any>("settlement", `
      SELECT id, tenant_id, merchant_id,
             batch_date,
             batch_date         AS period_start,
             batch_date         AS period_end,
             gross_amount,
             fees_amount,
             fees_amount        AS fee_amount,
             net_amount,
             net_amount         AS net_payable,
             COALESCE('INR'::text, '') AS currency,
             utr, payout_ref, status, txn_count, created_at, completed_at
        FROM settlement_batches
       WHERE ${where}
       ORDER BY batch_date DESC LIMIT 200
    `, params).catch(() => []);
    return NextResponse.json({ batches });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
