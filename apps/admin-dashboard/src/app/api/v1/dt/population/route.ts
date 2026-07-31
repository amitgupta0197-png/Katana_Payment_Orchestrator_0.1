// GET /api/v1/dt/population — how much pay-in "population" merchants have sent back
// against the USDT advanced to them.
//   ?merchant=<providers.code>  one merchant's position
//   (no query)                  totals + per-merchant breakdown
//
// Admin/finance view. The DT banker's own view is served by
// /api/dt-banker-portal/overview, which scopes to the session's banker_id.
import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { payinPopulation, populationByMerchant } from "@/lib/dt-payin";
import { rows } from "@/lib/pg";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "FINANCE", "RISK"]);
  if ("response" in g) return g.response;

  const merchant = new URL(req.url).searchParams.get("merchant") ?? undefined;
  const [totals, byMerchant, unallocated] = await Promise.all([
    payinPopulation(merchant ? { payin_merchant_code: merchant } : {}),
    merchant ? Promise.resolve([]) : populationByMerchant(),
    rows<{ id: string; alert_id: string; banker_code: string; payin_merchant_code: string; amount: number; reason: string; created_at: string }>(
      "provider",
      `SELECT id::text, alert_id, banker_code, payin_merchant_code, amount::float AS amount, reason, created_at
         FROM dt_unallocated_payins
        WHERE status = 'OPEN' ${merchant ? "AND payin_merchant_code = $1" : ""}
        ORDER BY created_at DESC LIMIT 50`,
      merchant ? [merchant] : [],
    ).catch(() => []),
  ]);

  return NextResponse.json({ totals, by_merchant: byMerchant, unallocated });
}
