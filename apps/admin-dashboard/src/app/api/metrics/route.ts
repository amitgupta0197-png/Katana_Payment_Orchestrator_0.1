// GET /api/metrics — operational numbers in the Prometheus text format.
//
// Not public: the app is reachable from the internet, so the scrape authenticates with the
// cron key, as `x-cron-key: <key>` or `Authorization: Bearer <key>` (METRICS_TOKEN when set,
// else FIFO_CRON_KEY). No merchant is named in a label, only platform totals.

import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { rows } from "@/lib/pg";
import { circuitStates } from "@/lib/circuit-breaker";
import { jobStatuses } from "@/lib/jobs";

export const dynamic = "force-dynamic";

function allowed(req: Request): boolean {
  const key = process.env.METRICS_TOKEN || process.env.FIFO_CRON_KEY;
  if (!key) return false;
  const sent = req.headers.get("x-cron-key") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const a = Buffer.from(sent), b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");

class Metrics {
  private out: string[] = [];
  private seen = new Set<string>();
  add(name: string, help: string, value: number, labels: Record<string, string> = {}) {
    if (!this.seen.has(name)) { this.seen.add(name); this.out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`); }
    const l = Object.entries(labels).map(([k, v]) => `${k}="${esc(v)}"`).join(",");
    this.out.push(`${name}${l ? `{${l}}` : ""} ${Number.isFinite(value) ? value : 0}`);
  }
  text() { return this.out.join("\n") + "\n"; }
}

const CIRCUIT: Record<string, number> = { CLOSED: 0, HALF_OPEN: 1, OPEN: 2 };

export async function GET(req: Request) {
  if (!allowed(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const m = new Metrics();
  // Each section is read by itself: a database that cannot be reached drops its own numbers
  // and is reported in katana_metrics_section_up, not as a failed scrape.
  const section = async (name: string, read: () => Promise<void>) => {
    const ok = await read().then(() => true, () => false);
    m.add("katana_metrics_section_up", "1 when this section of the metrics could be read", ok ? 1 : 0, { section: name });
  };

  await section("payins", async () => {
    const r = await rows<{ status: string; flow: string; mode: string; n: number; amount: string }>("vendorGateway", `
      SELECT status, COALESCE(channel_type, 'UNCLASSIFIED') AS flow, CASE WHEN livemode THEN 'live' ELSE 'test' END AS mode,
             COUNT(*)::int AS n, COALESCE(SUM(amount), 0)::text AS amount
        FROM vendor_payin_orders
       WHERE vendor = 'KATANA' AND created_at > now() - interval '24 hours'
       GROUP BY 1, 2, 3
    `);
    for (const x of r) {
      const labels = { status: x.status, flow: x.flow, mode: x.mode };
      m.add("katana_payin_orders_24h", "Pay-in orders created in the last 24 hours", x.n, labels);
      m.add("katana_payin_amount_inr_24h", "Rupees of pay-in orders created in the last 24 hours", Number(x.amount), labels);
    }
    const p = await rows<{ pending: number; held: number; oldest: number | null }>("vendorGateway", `
      SELECT COUNT(*)::int AS pending,
             COUNT(*) FILTER (WHERE COALESCE((meta->>'hold')::boolean, false))::int AS held,
             EXTRACT(EPOCH FROM (now() - MIN(created_at)))::int AS oldest
        FROM vendor_payin_orders
       WHERE vendor = 'KATANA' AND livemode AND status NOT IN ('SUCCESS','SUCCEEDED','FAILED','EXPIRED')
    `);
    m.add("katana_payin_pending", "Live pay-in orders not yet final", p[0]?.pending ?? 0);
    m.add("katana_payin_held", "Live pay-in orders held for a manual check", p[0]?.held ?? 0);
    m.add("katana_payin_oldest_pending_seconds", "Age of the oldest live pay-in order not yet final", p[0]?.oldest ?? 0);
    const c = await rows<{ n: number; oldest: number | null }>("vendorGateway", `
      SELECT COUNT(*)::int AS n, EXTRACT(EPOCH FROM (now() - MIN(created_at)))::int AS oldest
        FROM vendor_manual_cases
       WHERE status = 'OPEN' AND reason <> 'UNMATCHED' AND created_at > now() - interval '7 days'
    `);
    m.add("katana_recon_cases_open", "Bank credits of the last 7 days waiting for a person's decision", c[0]?.n ?? 0);
    m.add("katana_recon_lag_seconds", "Age of the oldest of them", c[0]?.oldest ?? 0);
  });

  await section("webhooks", async () => {
    const r = await rows<{ status: string; n: number }>("notification",
      `SELECT status, COUNT(*)::int AS n FROM webhook_outbox WHERE created_at > now() - interval '24 hours' GROUP BY 1`);
    for (const x of r) m.add("katana_webhook_outbox_24h", "Merchant callbacks queued in the last 24 hours, by state", x.n, { status: x.status });
    const d = await rows<{ n: number }>("notification",
      `SELECT COUNT(*)::int AS n FROM webhook_outbox WHERE status = 'PENDING' AND next_attempt_at <= now()`);
    m.add("katana_dlq_depth", "Merchant callbacks due and not yet sent", d[0]?.n ?? 0, { queue_name: "webhook" });
  });

  await section("circuits", async () => {
    for (const c of await circuitStates())
      m.add("katana_circuit_breaker_state", "0 closed, 1 half-open, 2 open", CIRCUIT[c.circuit_state] ?? 0, { provider: c.provider_code });
  });

  await section("jobs", async () => {
    for (const j of await jobStatuses()) {
      m.add("katana_job_last_run_age_seconds", "Seconds since a scheduled job last finished", j.age_seconds ?? -1, { job: j.job });
      m.add("katana_job_last_ok", "1 when a scheduled job's last run succeeded", j.last_ok ? 1 : 0, { job: j.job });
      m.add("katana_job_stale", "1 when the crontab has stopped calling a scheduled job", j.stale ? 1 : 0, { job: j.job });
    }
    const a = await rows<{ severity: string; n: number }>("audit",
      `SELECT severity, COUNT(*)::int AS n FROM ops_alerts WHERE resolved_at IS NULL GROUP BY 1`);
    for (const x of a) m.add("katana_ops_alerts_open", "Open ops alerts", x.n, { severity: x.severity });
  });

  return new NextResponse(m.text(), { headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" } });
}
