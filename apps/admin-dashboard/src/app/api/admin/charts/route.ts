// Aggregated time-series + breakdowns for the dashboard infographics.
// All sub-queries swallow errors so a missing table never breaks the dashboard.

import { NextResponse } from "next/server";
import { rows } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

const safe = async <T,>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback);

interface DayRow { day: string; total: number; success: number; failed: number; gross: number }

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;

  const DAYS = 14;
  const series = `
    SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE status IN ('SUCCESS','SUCCEEDED'))::int AS success,
           COUNT(*) FILTER (WHERE status IN ('FAILED','EXPIRED'))::int AS failed,
           COALESCE(SUM(amount)::float,0) AS gross
      FROM %T
     WHERE created_at >= now() - interval '${DAYS} days'
     GROUP BY 1`;

  const [checkoutSeries, payinSeries, funnel, coStatus, ppStatus] = await Promise.all([
    safe(rows<DayRow>("checkout", series.replace("%T", "checkout_orders")), []),
    safe(rows<DayRow>("vendorGateway", series.replace("%T", "vendor_payin_orders")), []),
    safe(rows<{ stage: string; n: number }>("merchant", `SELECT stage, COUNT(*)::int AS n FROM merchants GROUP BY stage`), []),
    safe(rows<{ status: string; n: number }>("checkout", `SELECT status, COUNT(*)::int AS n FROM checkout_orders GROUP BY status`), []),
    safe(rows<{ status: string; n: number }>("vendorGateway", `SELECT status, COUNT(*)::int AS n FROM vendor_payin_orders GROUP BY status`), []),
  ]);

  // Merge the two sources into one continuous DAYS-day axis.
  const byDay = new Map<string, { total: number; success: number; failed: number; gross: number }>();
  for (const r of [...checkoutSeries, ...payinSeries]) {
    const cur = byDay.get(r.day) ?? { total: 0, success: 0, failed: 0, gross: 0 };
    cur.total += r.total; cur.success += r.success; cur.failed += r.failed; cur.gross += r.gross;
    byDay.set(r.day, cur);
  }
  const txn_series: Array<{ day: string; label: string; total: number; success: number; failed: number; gross: number }> = [];
  const now = new Date();
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(now); d.setDate(now.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const v = byDay.get(key) ?? { total: 0, success: 0, failed: 0, gross: 0 };
    txn_series.push({ day: key, label: key.slice(5), ...v });
  }

  // Status breakdown across both order sources.
  const status = { success: 0, pending: 0, failed: 0 };
  for (const r of [...coStatus, ...ppStatus]) {
    if (["SUCCESS", "SUCCEEDED"].includes(r.status)) status.success += r.n;
    else if (["FAILED", "EXPIRED"].includes(r.status)) status.failed += r.n;
    else status.pending += r.n; // CREATED / PENDING / PROCESSING / etc.
  }

  return NextResponse.json({
    txn_series,
    status,
    funnel: funnel.sort((a, b) => a.stage.localeCompare(b.stage)),
  });
}
