// Aggregate stats for the SUPER_ADMIN ops cockpit. Returns counts + simple
// rollups across the major business domains. All sub-queries swallow errors
// so a missing service / table never breaks the dashboard.

import { NextResponse } from "next/server";
import { rows } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

const safe = async <T,>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback);

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayIso = today.toISOString();

  const [
    providers, providersPending,
    merchants, merchantsByStage,
    kybPending,
    makerChecker,
    disputesOpen,
    riskCases,
    todayOrders, failedToday,
    todayPayin, failedPayinToday,
    settlementToday,
  ] = await Promise.all([
    safe(rows<{ n: number }>("provider", `SELECT COUNT(*)::int AS n FROM providers WHERE tenant_id='tenant-default'`), [{ n: 0 }]),
    safe(rows<{ n: number }>("provider", `SELECT COUNT(*)::int AS n FROM providers WHERE tenant_id='tenant-default' AND kyc_status IN ('PENDING','IN_REVIEW')`), [{ n: 0 }]),
    safe(rows<{ n: number }>("merchant", `SELECT COUNT(*)::int AS n FROM merchants`), [{ n: 0 }]),
    safe(rows<{ stage: string; n: number }>("merchant", `SELECT stage, COUNT(*)::int AS n FROM merchants GROUP BY stage`), []),
    safe(rows<{ n: number }>("kybPayments", `SELECT COUNT(*)::int AS n FROM kyb_cases WHERE status NOT IN ('APPROVED','REJECTED','EXPIRED')`), [{ n: 0 }]),
    safe(rows<{ n: number }>("audit", `SELECT COUNT(*)::int AS n FROM maker_checker_requests WHERE status='PENDING'`), [{ n: 0 }]),
    safe(rows<{ n: number }>("audit", `SELECT COUNT(*)::int AS n FROM disputes WHERE status NOT IN ('WON','LOST','EXPIRED')`).catch(() =>
         rows<{ n: number }>("settlement", `SELECT COUNT(*)::int AS n FROM disputes WHERE status NOT IN ('WON','LOST','EXPIRED')`)), [{ n: 0 }]),
    safe(rows<{ n: number }>("riskVelocity", `SELECT COUNT(*)::int AS n FROM risk_cases WHERE status NOT IN ('CLEARED','BLOCKED')`), [{ n: 0 }]),
    safe(rows<{ n: number; gross: number }>("checkout",
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount)::float,0) AS gross FROM checkout_orders WHERE created_at >= $1`, [todayIso]), [{ n: 0, gross: 0 }]),
    safe(rows<{ n: number }>("checkout",
      `SELECT COUNT(*)::int AS n FROM checkout_orders WHERE created_at >= $1 AND status IN ('FAILED','EXPIRED')`, [todayIso]), [{ n: 0 }]),
    // Katana Pay (PoolPay) pay-ins are tracked in vendor_payin_orders — include them
    // so the "today" KPIs reflect S2S/QR pay-ins, not just checkout-gateway orders.
    safe(rows<{ n: number; gross: number }>("vendorGateway",
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount)::float,0) AS gross FROM vendor_payin_orders WHERE created_at >= $1`, [todayIso]), [{ n: 0, gross: 0 }]),
    safe(rows<{ n: number }>("vendorGateway",
      `SELECT COUNT(*)::int AS n FROM vendor_payin_orders WHERE created_at >= $1 AND status IN ('FAILED','EXPIRED')`, [todayIso]), [{ n: 0 }]),
    safe(rows<{ batches: number; net: number }>("settlement",
      `SELECT COUNT(*)::int AS batches, COALESCE(SUM(net_amount)::float,0) AS net FROM settlement_batches WHERE batch_date >= $1`, [todayIso]), [{ batches: 0, net: 0 }]),
  ]);

  const txnCount = (todayOrders[0]?.n ?? 0) + (todayPayin[0]?.n ?? 0);
  const grossTotal = (todayOrders[0]?.gross ?? 0) + (todayPayin[0]?.gross ?? 0);
  const failedCount = (failedToday[0]?.n ?? 0) + (failedPayinToday[0]?.n ?? 0);
  const successRate = txnCount > 0 ? Math.round(((txnCount - failedCount) / txnCount) * 1000) / 10 : null;

  return NextResponse.json({
    providers: {
      total: providers[0]?.n ?? 0,
      kyc_pending: providersPending[0]?.n ?? 0,
    },
    merchants: {
      total: merchants[0]?.n ?? 0,
      by_stage: merchantsByStage.reduce<Record<string, number>>((acc, r) => { acc[r.stage] = r.n; return acc; }, {}),
    },
    queue: {
      kyb_pending:        kybPending[0]?.n ?? 0,
      maker_checker:      makerChecker[0]?.n ?? 0,
      disputes_open:      disputesOpen[0]?.n ?? 0,
      risk_cases:         riskCases[0]?.n ?? 0,
    },
    today: {
      transactions: txnCount,
      failed:       failedCount,
      success_rate: successRate,
      gross:        grossTotal,
      settlement_batches: settlementToday[0]?.batches ?? 0,
      settlement_net:     settlementToday[0]?.net ?? 0,
    },
  });
}
