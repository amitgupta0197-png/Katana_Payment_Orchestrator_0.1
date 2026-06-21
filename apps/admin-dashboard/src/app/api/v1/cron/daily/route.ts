// POST /api/v1/cron/daily — scheduled daily operations job (BRD §28 Daily Closure,
// §21, §29). Runs the SLA sweep, a reconciliation pass and the anomaly scan.
// Protected by a shared secret header (x-cron-key == FIFO_CRON_KEY) instead of a
// session, so a system cron / scheduler can call it. Returns a run summary.

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { sweepSlaBreaches } from "@/lib/fifo";
import { runReconciliation } from "@/lib/fifo-recon";
import { scanAnomalies } from "@/lib/fifo-anomaly";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const key = process.env.FIFO_CRON_KEY;
  if (!key) return NextResponse.json({ error: "cron disabled (FIFO_CRON_KEY unset)" }, { status: 503 });
  if (req.headers.get("x-cron-key") !== key) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const out: Record<string, unknown> = { ran_at: new Date().toISOString() };
  try {
    out.sla_sweep = await sweepSlaBreaches().catch((e) => ({ error: (e as Error).message }));
    out.reconciliation = await runReconciliation({ source: "LEDGER", createdBy: "cron@daily" }).catch((e) => ({ error: (e as Error).message }));
    out.anomaly = await scanAnomalies().catch((e) => ({ error: (e as Error).message }));
    return NextResponse.json({ ok: true, ...out });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
