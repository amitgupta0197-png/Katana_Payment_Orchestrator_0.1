// GET /api/v1/dashboard — aggregated FIFO operations stats for the persona
// dashboards (BRD §31). Single call returns admin/operator/finance/risk widgets.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "OPERATOR", "FINANCE", "RISK", "COMPLIANCE", "MERCHANT"]);
  if ("response" in g) return g.response;
  // Merchants see only their own slice (§31 merchant dashboard).
  const mid = g.session.persona === "MERCHANT" ? g.session.scope_id : null;
  const oFilter = mid ? "WHERE merchant_id = $1" : "";
  const oParams = mid ? [mid] : [];
  try {
    const byStatus = await rows<any>("fifo", `
      SELECT direction, status, COUNT(*)::int AS n, COALESCE(SUM(amount_minor),0)::text AS amt
        FROM fifo_orders ${oFilter} GROUP BY direction, status
    `, oParams);
    const queue = mid ? [] : await rows<any>("fifo", `
      SELECT status, COUNT(*)::int AS n FROM fifo_queue GROUP BY status
    `);
    const breaches = mid ? 0 : (await rows<{ n: number }>("fifo", `SELECT COUNT(*)::int AS n FROM fifo_queue WHERE reassign_count > 0`))[0]?.n ?? 0;
    const ops = mid ? { total: 0, active: 0 } : (await rows<any>("fifo", `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='ACTIVE')::int AS active FROM fifo_operators`))[0] ?? { total: 0, active: 0 };
    const alerts = await rows<any>("fifo", `SELECT alert_type, COUNT(*)::int AS n FROM fifo_fraud_alerts WHERE status='OPEN' ${mid ? "AND merchant_id = $1" : ""} GROUP BY alert_type`, oParams);
    const finPattern = mid ? `LIABILITIES.MERCHANT_PAYABLE.${mid}` : "LIABILITIES.MERCHANT_PAYABLE.%";
    const resPattern = mid ? `LIABILITIES.MERCHANT_RESERVE.${mid}` : "LIABILITIES.MERCHANT_RESERVE.%";
    const fin = (await rows<any>("ledger", `
      SELECT
        COALESCE(SUM(CASE WHEN a.code LIKE $1 THEN (CASE WHEN ll.side='C' THEN ll.amount_minor ELSE -ll.amount_minor END) ELSE 0 END),0)::text AS payable,
        COALESCE(SUM(CASE WHEN a.code LIKE $2 THEN (CASE WHEN ll.side='C' THEN ll.amount_minor ELSE -ll.amount_minor END) ELSE 0 END),0)::text AS reserve
        FROM ledger_lines ll JOIN accounts a ON a.id = ll.account_id
    `, [finPattern, resPattern]).catch(() => [{ payable: "0", reserve: "0" }]))[0] ?? { payable: "0", reserve: "0" };

    const pick = (dir: string, st: string) => byStatus.find((r) => r.direction === dir && r.status === st) ?? { n: 0, amt: "0" };
    const sumDir = (dir: string, sts: string[]) => byStatus.filter((r) => r.direction === dir && sts.includes(r.status)).reduce((a, r) => a + r.n, 0);
    const q = (st: string) => queue.find((r) => r.status === st)?.n ?? 0;
    const alert = (t: string) => alerts.find((a) => a.alert_type === t)?.n ?? 0;

    return NextResponse.json({
      payin: {
        completed_count: pick("PAYIN", "COMPLETED").n, completed_amount_minor: pick("PAYIN", "COMPLETED").amt,
        queued: q("QUEUED"), processing: sumDir("PAYIN", ["ASSIGNED", "ACCEPTED", "PROCESSING", "PROOF_UPLOADED"]),
      },
      payout: {
        completed_count: pick("PAYOUT", "COMPLETED").n, completed_amount_minor: pick("PAYOUT", "COMPLETED").amt,
        pending: sumDir("PAYOUT", ["QUEUED", "ASSIGNED", "ACCEPTED", "PROCESSING", "PROOF_UPLOADED", "HOLD"]),
      },
      queue: { queued: q("QUEUED"), assigned: q("ASSIGNED"), accepted: q("ACCEPTED"), sla_breaches: breaches },
      exceptions: {
        hold: sumDir("PAYIN", ["HOLD"]) + sumDir("PAYOUT", ["HOLD"]),
        rejected: sumDir("PAYIN", ["REJECTED"]) + sumDir("PAYOUT", ["REJECTED"]),
        failed: sumDir("PAYIN", ["FAILED"]) + sumDir("PAYOUT", ["FAILED"]),
      },
      operators: { active: ops.active, total: ops.total },
      risk: { open_alerts: alerts.reduce((a, r) => a + r.n, 0), duplicate_utr: alert("DUPLICATE_UTR"), velocity: alert("VELOCITY"), high_value: alert("HIGH_VALUE") },
      finance: { net_payable_minor: fin.payable, reserve_minor: fin.reserve, currency: "INR" },
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
