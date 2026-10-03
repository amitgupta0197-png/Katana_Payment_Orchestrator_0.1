// The ops monitor: conditions that need a person, checked on a schedule (cron/monitor, every
// five minutes) and sent to the admin Telegram chats through lib/ops-alert.
//
// Each check reads one number and turns one alert on or off. A check that cannot be read is
// reported in the run's result and leaves its alert as it was — "could not tell" neither
// raises nor resolves.
//
//   webhook:dead_letter    merchant callbacks that gave up in the last 24 hours
//   webhook:backlog        callbacks due for more than 10 minutes (the outbox is not being drained)
//   payin:callback_owed    final orders whose merchant has still not been told after 10 minutes
//   payin:held             live orders held for a manual check for more than 30 minutes
//   recon:cases_aged       bank credits that need a decision (two orders fit, the amount is off, the
//                          phone is not trusted) and have waited more than 4 hours. A credit with no
//                          order at all is routine and is not counted.
//   settlement:sla         settlement requests not paid within a day (T+1)
//   jobs:stale             scheduled jobs the crontab has stopped calling
//   jobs:failing           scheduled jobs whose last run failed
//   gateway:health:<GW>    a gateway whose recent orders are mostly not being paid (lib/gateway-performance)
//   gateway:no_webhook:<GW>, gateway:slow_confirmation:<GW>, gateway:high_revival:<GW>
//                          a gateway that has stopped calling, confirms slowly, or pays after expiry
//   onboarding:setup_missing  live bankers missing what their merchant's services or flow require
//                          (lib/merchant-setup)
//   compliance:flags       transaction patterns on live pay-ins waiting for review (lib/payin-compliance)

import { rows, type DbKey } from "@/lib/pg";
import { setAlert, type AlertSeverity } from "@/lib/ops-alert";
import { jobStatuses } from "@/lib/jobs";
import { scanPayinCompliance, type ComplianceScanResult } from "@/lib/payin-compliance-store";
import { checkGatewayHealth, checkGatewayWebhookHealth } from "@/lib/gateway-performance";
import { checkBankerSetup } from "@/lib/merchant-setup";

interface Check {
  key: string;
  severity: AlertSeverity;
  db: DbKey;
  /** Returns one row: n (how many) and, optionally, detail (a short text for the alert). */
  sql: string;
  /** Raise when n is above this. */
  above: number;
  title: (n: number) => string;
  body?: string;
  repeatMinutes?: number;
}

const CHECKS: Check[] = [
  {
    key: "webhook:dead_letter", severity: "WARN", db: "notification", above: 0, repeatMinutes: 360,
    sql: `SELECT COUNT(*)::int AS n FROM webhook_outbox
           WHERE status = 'DEAD_LETTER' AND dead_lettered_at > now() - interval '24 hours'`,
    title: (n) => `${n} merchant callback${n === 1 ? "" : "s"} gave up in the last 24 hours`,
    body: "Every retry failed. Check the merchant's callback URL, then resend from Webhooks.",
  },
  {
    key: "webhook:backlog", severity: "CRITICAL", db: "notification", above: 10,
    sql: `SELECT COUNT(*)::int AS n FROM webhook_outbox
           WHERE status = 'PENDING' AND next_attempt_at < now() - interval '10 minutes'`,
    title: (n) => `${n} merchant callbacks are overdue`,
    body: "They were due more than 10 minutes ago. The job that sends them is not running.",
  },
  {
    key: "payin:callback_owed", severity: "CRITICAL", db: "vendorGateway", above: 0,
    sql: `SELECT COUNT(*)::int AS n FROM vendor_payin_orders
           WHERE vendor = 'KATANA' AND merchant_id IS NOT NULL AND livemode
             AND status IN ('SUCCESS','SUCCEEDED')
             AND updated_at BETWEEN now() - interval '24 hours' AND now() - interval '10 minutes'
             AND (meta->'callback' IS NULL OR meta->'callback'->>'skipped' = 'not queued')`,
    title: (n) => `${n} paid order${n === 1 ? "" : "s"}: merchant not told`,
    body: "Paid more than 10 minutes ago with no callback queued. The status sweep should have sent it.",
  },
  {
    key: "payin:held", severity: "WARN", db: "vendorGateway", above: 0, repeatMinutes: 120,
    sql: `SELECT COUNT(*)::int AS n FROM vendor_payin_orders
           WHERE vendor = 'KATANA' AND livemode AND status = 'PENDING'
             AND COALESCE((meta->>'hold')::boolean, false)
             AND created_at BETWEEN now() - interval '24 hours' AND now() - interval '30 minutes'`,
    title: (n) => `${n} held order${n === 1 ? "" : "s"} waiting for a manual check`,
    body: "High-amount orders are not confirmed automatically. Confirm or reject them in P2P Pay-ins.",
  },
  {
    key: "recon:cases_aged", severity: "WARN", db: "vendorGateway", above: 0, repeatMinutes: 240,
    sql: `SELECT COUNT(*)::int AS n FROM vendor_manual_cases
           WHERE status = 'OPEN' AND reason <> 'UNMATCHED'
             AND created_at BETWEEN now() - interval '7 days' AND now() - interval '4 hours'`,
    title: (n) => `${n} bank credit${n === 1 ? "" : "s"} waiting for a decision for over 4 hours`,
    body: "Each fits more than one order, or its amount or its phone could not be trusted. Resolve them in Reconciliation.",
  },
  {
    key: "settlement:sla", severity: "WARN", db: "provider", above: 0, repeatMinutes: 360,
    sql: `SELECT COUNT(*)::int AS n FROM provider_branch_settlements
           WHERE status IN ('REQUESTED','ACCEPTED','PROCESSING') AND requested_at < now() - interval '24 hours'`,
    title: (n) => `${n} settlement request${n === 1 ? "" : "s"} unpaid after a day`,
    body: "Requested more than 24 hours ago and still not marked paid.",
  },
];

export interface MonitorResult {
  checks: Record<string, number | { error: string }>;
  stale_jobs: string[];
  failing_jobs: string[];
  compliance: ComplianceScanResult | { error: string };
  gateways: { gateways: number; unhealthy: string[] } | { error: string };
  gateway_webhooks: { gateways: number; alerts: string[] } | { error: string };
  banker_setup: { merchants: number; not_ready: string[] } | { error: string };
}

export async function runMonitor(): Promise<MonitorResult> {
  const out: MonitorResult = { checks: {}, stale_jobs: [], failing_jobs: [], compliance: { error: "not run" }, gateways: { error: "not run" }, gateway_webhooks: { error: "not run" }, banker_setup: { error: "not run" } };

  for (const c of CHECKS) {
    try {
      const n = (await rows<{ n: number }>(c.db, c.sql))[0]?.n ?? 0;
      out.checks[c.key] = n;
      await setAlert(n > c.above, { key: c.key, severity: c.severity, title: c.title(n), body: c.body, repeatMinutes: c.repeatMinutes });
    } catch (err) {
      out.checks[c.key] = { error: (err as Error).message };
    }
  }

  out.compliance = await scanPayinCompliance().catch((err) => ({ error: (err as Error).message }));
  out.gateways = await checkGatewayHealth().catch((err) => ({ error: (err as Error).message }));
  out.gateway_webhooks = await checkGatewayWebhookHealth().catch((err) => ({ error: (err as Error).message }));
  out.banker_setup = await checkBankerSetup().catch((err) => ({ error: (err as Error).message }));

  // The monitor's own heartbeat is written after it returns, so it never reports itself.
  const jobs = (await jobStatuses()).filter((j) => j.job !== "monitor");
  out.stale_jobs = jobs.filter((j) => j.stale).map((j) => j.job);
  out.failing_jobs = jobs.filter((j) => j.last_ok === false && !j.stale).map((j) => j.job);
  await setAlert(out.stale_jobs.length > 0, {
    key: "jobs:stale", severity: "CRITICAL",
    title: `Scheduled job${out.stale_jobs.length === 1 ? "" : "s"} not running: ${out.stale_jobs.join(", ")}`,
    body: "The server's crontab has stopped calling it. Check `crontab -l` and the service.",
  });
  await setAlert(out.failing_jobs.length > 0, {
    key: "jobs:failing", severity: "WARN",
    title: `Scheduled job${out.failing_jobs.length === 1 ? "" : "s"} failing: ${out.failing_jobs.join(", ")}`,
    body: jobs.filter((j) => j.last_ok === false && !j.stale).map((j) => `${j.job}: ${j.last_error ?? "failed"}`).join("\n"),
  });
  return out;
}
