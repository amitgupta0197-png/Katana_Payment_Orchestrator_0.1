// GET /api/dt-banker-portal/overview — the banker's own DT position: KPIs, traffic
// wallet, active DT lots, current rate and commission earned. BANKER-gated; every
// query is scoped to the session's banker_id (scope_id) — no cross-banker reads.
import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { rows } from "@/lib/pg";
import { dashboardKpis, trafficWallet, dtWallet, currentRate } from "@/lib/dt";
import { payinPopulation } from "@/lib/dt-payin";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["BANKER"]);
  if ("response" in g) return g.response;
  const bankerId = g.session.scope_id;
  if (!bankerId) return NextResponse.json({ error: "BANKER session missing scope_id" }, { status: 400 });

  const [kpis, wallet, lots, rate, comm, population, popByMerchant] = await Promise.all([
    dashboardKpis({ banker_id: bankerId }),
    trafficWallet(bankerId),
    dtWallet(bankerId),
    currentRate(),
    // Commission scoped to this banker via the purchase-lot linkage (dashboardKpis
    // reports the global commission pot, which a banker must not see).
    rows<any>("provider", `
      SELECT COALESCE(SUM(e.banker_commission),0)::float AS banker_commission
        FROM commission_entries e JOIN dt_purchases p ON p.id = e.purchase_lot
       WHERE p.banker_id = $1
    `, [bankerId]).catch(() => [{ banker_commission: 0 }]),
    // Population repaid against THIS banker's lots only — scoped by banker_id, so one
    // banker never sees another's position.
    payinPopulation({ banker_id: bankerId }),
    // Which merchants are actually sending traffic against this banker's lots.
    rows<{ payin_merchant_code: string; lots: number; consumed: number }>("provider", `
      SELECT p.payin_merchant_code,
             COUNT(DISTINCT p.id)::int              AS lots,
             COALESCE(SUM(a.consumed),0)::float     AS consumed
        FROM dt_purchases p LEFT JOIN traffic_allocations a ON a.purchase_id = p.id
       WHERE p.banker_id = $1 AND p.payin_merchant_code IS NOT NULL
       GROUP BY p.payin_merchant_code ORDER BY consumed DESC
    `, [bankerId]).catch(() => []),
  ]);

  return NextResponse.json({
    kpis: {
      ...kpis,
      banker_commission: comm[0]?.banker_commission ?? 0,
      // never expose Katana's margin or the merchant charge to the banker persona
      katana_margin: undefined,
      merchant_charge: undefined,
    },
    wallet,
    lots,
    rate,
    population,
    population_by_merchant: popByMerchant,
  });
}
