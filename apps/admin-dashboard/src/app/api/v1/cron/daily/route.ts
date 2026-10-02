// POST /api/v1/cron/daily — scheduled daily operations job (BRD §28 Daily Closure,
// §21, §29). Runs the SLA sweep, a reconciliation pass, the anomaly scan and the TLS
// certificate check (an alert from 30 days before it expires).
// Protected by a shared secret header (x-cron-key == FIFO_CRON_KEY) instead of a
// session, so a system cron / scheduler can call it. Returns a run summary.

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { sweepSlaBreaches, sweepAssignmentSla, sweepVerificationSla } from "@/lib/fifo";
import { runReconciliation } from "@/lib/fifo-recon";
import { runProviderPayoutRecon } from "@/lib/provider-payout-recon";
import { scanAnomalies } from "@/lib/fifo-anomaly";
import { beat } from "@/lib/jobs";
import { certStatus, publicHost } from "@/lib/tls-check";
import { setAlert } from "@/lib/ops-alert";
import { pruneApiLog } from "@/lib/api-log";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const key = process.env.FIFO_CRON_KEY;
  if (!key) return NextResponse.json({ error: "cron disabled (FIFO_CRON_KEY unset)" }, { status: 503 });
  if (req.headers.get("x-cron-key") !== key) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const out: Record<string, unknown> = { ran_at: new Date().toISOString() };
  try {
    out.sla_sweep = await sweepSlaBreaches().catch((e) => ({ error: (e as Error).message }));
    out.assignment_sla = await sweepAssignmentSla().catch((e) => ({ error: (e as Error).message }));
    out.verification_sla = await sweepVerificationSla().catch((e) => ({ error: (e as Error).message }));
    out.reconciliation = await runReconciliation({ source: "LEDGER", createdBy: "cron@daily" }).catch((e) => ({ error: (e as Error).message }));
    // Yesterday's gateway payouts against each gateway's own records (reports exceptions, changes nothing).
    const yesterday = new Date(Date.now() - 86_400_000);
    out.provider_payout_recon = await runProviderPayoutRecon({ from: yesterday, to: yesterday, createdBy: "cron@daily" }).catch((e) => ({ error: (e as Error).message }));
    out.anomaly = await scanAnomalies().catch((e) => ({ error: (e as Error).message }));
    // The certificate customers see. An unreachable host leaves the alert as it was.
    const cert = await certStatus(publicHost()).catch((e) => ({ error: (e as Error).message }));
    out.tls = cert;
    if ("days_left" in cert)
      await setAlert(cert.days_left < 30, {
        key: "tls:expiry", severity: cert.days_left < 7 ? "CRITICAL" : "WARN", repeatMinutes: 1440,
        title: `TLS certificate for ${cert.host} expires in ${cert.days_left} day${cert.days_left === 1 ? "" : "s"}`,
        body: "Renew it before then: customers cannot reach the pay page on an expired certificate.",
      });
    // The API request log keeps 90 days (lib/api-log).
    out.api_log_pruned = await pruneApiLog(90).catch((e) => ({ error: (e as Error).message }));
    await beat("daily", 86_400, true, out);
    return NextResponse.json({ ok: true, ...out });
  } catch (err) {
    await beat("daily", 86_400, false, { error: (err as Error).message });
    const e = pgError(err); return NextResponse.json(e.body, { status: e.status });
  }
}
