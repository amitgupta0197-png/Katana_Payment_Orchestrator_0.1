// GET /api/banker-portal/overview — the banker's own DT position: KPIs, traffic
// wallet, active DT lots, current rate and commission earned. BANKER-gated; every
// query is scoped to the session's banker_id (scope_id) — no cross-banker reads.
import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { rows } from "@/lib/pg";
import { dashboardKpis, trafficWallet, dtWallet, currentRate } from "@/lib/dt";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["BANKER"]);
  if ("response" in g) return g.response;
  const bankerId = g.session.scope_id;
  if (!bankerId) return NextResponse.json({ error: "BANKER session missing scope_id" }, { status: 400 });

  const [kpis, wallet, lots, rate, comm] = await Promise.all([
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
  });
}
