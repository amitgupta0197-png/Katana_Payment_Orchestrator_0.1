// The circuit breaker, the scheduled-job routes, the metrics and the deep health check against
// a real database. Run with `pnpm test:integration`.
//
// IT WRITES ROWS, so it only runs against a local database (PG_HOST localhost / 127.0.0.1). It
// removes its own circuit and heartbeats. The two job routes do their real work on that
// database: the monitor leaves its alerts open, and the reserve release releases what is due.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rows } from "@/lib/pg";
import { claimProbe, getCircuit, recordFailure, recordSuccess, resetCircuit, config } from "@/lib/circuit-breaker";
import { isSealed, openText, sealPlaintextSecrets } from "@/lib/sealed-text";
import { recordSecurityEvent } from "@/lib/security-event";
import { gatewayPerformance, isUnhealthy, platformSummary } from "@/lib/gateway-performance";
import { platformToday, gatewayLeague } from "@/lib/reports";
import { POST as monitorPost } from "@/app/api/v1/cron/monitor/route";
import { POST as reservePost } from "@/app/api/v1/cron/reserve-release/route";
import { GET as metricsGet } from "@/app/api/metrics/route";
import { GET as healthGet } from "@/app/api/health/route";

const HOST = process.env.PG_HOST ?? "localhost";
const LOCAL = ["localhost", "127.0.0.1", "::1"].includes(HOST);
const opts = { skip: LOCAL ? false : `refusing to write to a non-local database (${HOST})` };
const GW = "itestgw";            // stored lowercase, like the seeded rows; callers pass either case
const KEY = "itest-cron-key";
let savedKey: string | undefined;

const cleanup = async () => {
  await rows("notification", "DELETE FROM merchant_webhook_configs WHERE merchant_id = 'ITEST-SEAL'");
  await rows("vendorGateway", "DELETE FROM vendor_security_alerts WHERE detail LIKE 'itest %'");
  await rows("audit", "DELETE FROM ops_alerts WHERE alert_key = 'security:BAD_SIGNATURE'");
  await rows("routingEngine", "DELETE FROM provider_health_snapshot WHERE provider_code = $1", [GW]);
  await rows("routingEngine", "DELETE FROM circuit_breaker_events WHERE provider_code = $1", [GW.toUpperCase()]);
  await rows("audit", "DELETE FROM ops_alerts WHERE alert_key = $1", [`circuit:${GW.toUpperCase()}`]);
};
const events = async () => (await rows<{ event: string }>("routingEngine",
  "SELECT event FROM circuit_breaker_events WHERE provider_code = $1 ORDER BY id", [GW.toUpperCase()])).map((e) => e.event);
const call = (path: string, key?: string, method = "POST") =>
  new Request(`http://test${path}`, { method, headers: key ? { "x-cron-key": key } : {} });

before(async () => {
  savedKey = process.env.FIFO_CRON_KEY;
  process.env.FIFO_CRON_KEY = KEY;
  if (!LOCAL) return;
  await cleanup();
  await rows("routingEngine", "INSERT INTO provider_health_snapshot (provider_code) VALUES ($1)", [GW]);
});

after(async () => {
  if (LOCAL) {
    await cleanup();
    await rows("audit", "DELETE FROM job_heartbeats WHERE job IN ('monitor','reserve-release')");
  }
  if (savedKey === undefined) delete process.env.FIFO_CRON_KEY; else process.env.FIFO_CRON_KEY = savedKey;
  setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
});

test("the circuit trips at the threshold, whatever the case of the provider code", opts, async () => {
  const { threshold } = config();
  for (let i = 1; i < threshold; i++) assert.deepEqual(await recordFailure(GW.toUpperCase()), { tripped: false, state: "CLOSED" });
  assert.deepEqual(await recordFailure(GW), { tripped: true, state: "OPEN" });
  assert.deepEqual(await recordFailure(GW), { tripped: false, state: "OPEN" });   // already open: not a second trip
  assert.equal((await getCircuit("ItestGW"))?.circuit_state, "OPEN");
  assert.deepEqual(await events(), ["TRIPPED"]);
});

test("after the cool-off one read opens the probe; a failed probe starts the cool-off again", opts, async () => {
  const { cooldown_seconds } = config();
  await rows("routingEngine", "UPDATE provider_health_snapshot SET circuit_opened_at = now() - make_interval(secs => $2) WHERE provider_code = $1", [GW, cooldown_seconds + 5]);
  assert.equal((await getCircuit(GW))?.circuit_state, "HALF_OPEN");
  assert.equal((await getCircuit(GW))?.circuit_state, "HALF_OPEN");               // logged once, not per read
  assert.deepEqual(await recordFailure(GW), { tripped: true, state: "OPEN" });
  // The cool-off restarted: the circuit is still OPEN on the next read, not straight back to the probe.
  assert.equal((await getCircuit(GW))?.circuit_state, "OPEN");
  assert.deepEqual(await events(), ["TRIPPED", "HALF_OPEN", "PROBE_FAILED"]);
});

test("a recovering provider takes one probe at a time", opts, async () => {
  const { cooldown_seconds } = config();
  await rows("routingEngine", "UPDATE provider_health_snapshot SET circuit_opened_at = now() - make_interval(secs => $2) WHERE provider_code = $1", [GW, cooldown_seconds + 5]);
  assert.equal((await getCircuit(GW))?.circuit_state, "HALF_OPEN");
  const claims = await Promise.all(Array.from({ length: 6 }, () => claimProbe(GW.toUpperCase())));
  assert.equal(claims.filter(Boolean).length, 1);
  // A probe that never reported back gives the circuit up after its hold.
  await rows("routingEngine", "UPDATE provider_health_snapshot SET half_open_at = now() - interval '31 seconds' WHERE provider_code = $1", [GW]);
  assert.equal(await claimProbe(GW), true);
  // A failed probe reopens the circuit; once it is half-open again a new probe can be claimed.
  assert.deepEqual(await recordFailure(GW), { tripped: true, state: "OPEN" });
  assert.equal(await claimProbe(GW), false);
});

test("a successful probe closes the circuit, and a reset is logged with who did it", opts, async () => {
  const { cooldown_seconds } = config();
  await rows("routingEngine", "UPDATE provider_health_snapshot SET circuit_opened_at = now() - make_interval(secs => $2) WHERE provider_code = $1", [GW, cooldown_seconds + 5]);
  await getCircuit(GW);
  await recordSuccess(GW);
  const c = await getCircuit(GW);
  assert.deepEqual([c?.circuit_state, c?.consecutive_failures], ["CLOSED", 0]);
  await recordSuccess(GW);                                                         // already closed: nothing to log
  await resetCircuit(GW, "ops@itest");
  assert.deepEqual(await events(), ["TRIPPED", "HALF_OPEN", "PROBE_FAILED", "HALF_OPEN", "PROBE_FAILED", "HALF_OPEN", "RECOVERED", "RESET"]);
  const last = await rows<{ actor: string }>("routingEngine", "SELECT actor FROM circuit_breaker_events WHERE provider_code = $1 ORDER BY id DESC LIMIT 1", [GW.toUpperCase()]);
  assert.equal(last[0].actor, "ops@itest");
});

test("the job routes refuse a caller without the cron key", opts, async () => {
  assert.equal((await monitorPost(call("/api/v1/cron/monitor"))).status, 403);
  assert.equal((await monitorPost(call("/api/v1/cron/monitor", "wrong"))).status, 403);
  assert.equal((await reservePost(call("/api/v1/cron/reserve-release", KEY + "x"))).status, 403);
  assert.equal((await metricsGet(call("/api/metrics", undefined, "GET"))).status, 403);
});

test("the monitor runs every check and records its own run", opts, async () => {
  const res = await monitorPost(call("/api/v1/cron/monitor", KEY));
  const body = await res.json() as { ok: boolean; checks: Record<string, unknown>; stale_jobs: string[] };
  assert.equal(res.status, 200);
  for (const k of ["webhook:dead_letter", "webhook:backlog", "payin:callback_owed", "payin:held", "recon:cases_aged", "settlement:sla"])
    assert.equal(typeof body.checks[k], "number", `${k}: ${JSON.stringify(body.checks[k])}`);
  const hb = await rows<{ last_ok: boolean }>("audit", "SELECT last_ok FROM job_heartbeats WHERE job = 'monitor'");
  assert.equal(hb[0]?.last_ok, true);
});

test("the reserve release runs and reports what it released", opts, async () => {
  const res = await reservePost(call("/api/v1/cron/reserve-release", KEY));
  const body = await res.json() as { ok: boolean; released: number; total_minor: string };
  assert.deepEqual([res.status, body.ok, typeof body.released, typeof body.total_minor], [200, true, "number", "string"]);
});

test("the metrics are Prometheus text with every section readable", opts, async () => {
  const res = await metricsGet(new Request("http://test/api/metrics", { headers: { authorization: `Bearer ${KEY}` } }));
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^text\/plain/);
  for (const s of ["payins", "webhooks", "circuits", "jobs"]) assert.match(text, new RegExp(`katana_metrics_section_up\\{section="${s}"\\} 1`));
  assert.match(text, /katana_circuit_breaker_state\{provider="ITESTGW"\} 0/);
  assert.match(text, /katana_job_last_ok\{job="monitor"\} 1/);
  for (const line of text.trim().split("\n")) assert.match(line, /^(# (HELP|TYPE) \S+ .+|[a-z_0-9]+(\{[^}]*\})? -?[0-9.]+)$/, line);
});

test("the plain health check asks no database; the deep one reports it", opts, async () => {
  const plain = await healthGet(new Request("http://test/api/health"));
  assert.deepEqual(Object.keys(await plain.json()).sort(), ["ok", "service", "ts"]);
  const deep = await healthGet(new Request("http://test/api/health?deep=1"));
  const b = await deep.json() as { ok: boolean; db: boolean; jobs_stale: number };
  assert.equal(b.db, true);
  assert.equal(deep.status, b.jobs_stale === 0 ? 200 : 503);
});

test("plaintext secrets are sealed in place, still open to the same value, and are sealed only once", opts, async () => {
  await rows("notification", "INSERT INTO merchant_webhook_configs (merchant_id, target_url, secret, enabled) VALUES ('ITEST-SEAL', 'https://example.com/hook', 'itest-plain-secret', false)");
  const read = async () => (await rows<{ secret: string }>("notification", "SELECT secret FROM merchant_webhook_configs WHERE merchant_id = 'ITEST-SEAL'"))[0].secret;
  const first = await sealPlaintextSecrets();
  assert.ok((first.find((r) => r.table === "merchant_webhook_configs")?.sealed ?? 0) >= 1);
  const stored = await read();
  assert.equal(isSealed(stored), true);
  assert.equal(openText(stored), "itest-plain-secret");
  const second = await sealPlaintextSecrets();
  assert.deepEqual(second.map((r) => r.sealed), [0, 0, 0, 0]);
  assert.equal(await read(), stored);
});

test("a bad webhook signature is recorded once, however often it is repeated", opts, async () => {
  const detail = `itest pay-in webhook ${Date.now()}`;
  await recordSecurityEvent({ risk: "BAD_SIGNATURE", detail });
  await recordSecurityEvent({ risk: "BAD_SIGNATURE", detail });
  const got = await rows<{ risk_type: string; severity: string; status: string }>("vendorGateway",
    "SELECT risk_type, severity, status FROM vendor_security_alerts WHERE detail = $1", [detail]);
  assert.deepEqual(got, [{ risk_type: "BAD_SIGNATURE", severity: "HIGH", status: "OPEN" }]);
});

test("a gateway is unhealthy only with enough recent orders and too few of them paid", () => {
  assert.equal(isUnhealthy({ recent_rate: 0.5, recent_sample: 19 }, 0.65, 20), false);   // too few to say
  assert.equal(isUnhealthy({ recent_rate: 0.64, recent_sample: 20 }, 0.65, 20), true);
  assert.equal(isUnhealthy({ recent_rate: 0.65, recent_sample: 50 }, 0.65, 20), false);  // on the line is not below it
  assert.equal(isUnhealthy({ recent_rate: null, recent_sample: 0 }, 0.65, 20), false);
});

test("the platform summary and the gateway table read cleanly, and their Telegram reports build", opts, async () => {
  const s = await platformSummary();
  assert.match(s.date, /^\d{4}-\d{2}-\d{2}$/);
  for (const k of ["manual_cases", "compliance_flags", "ops_alerts", "dead_letter_callbacks_24h"] as const) assert.equal(typeof s.open[k], "number");
  assert.equal(Number.isFinite(s.payouts.paid_amount), true);
  for (const g of await gatewayPerformance(24 * 31)) {
    assert.equal(g.orders, g.paid + g.failed + g.expired + g.pending);
    assert.ok(g.recent_sample <= 50);
  }
  assert.equal((await platformToday()).includes("unavailable"), false);
  assert.equal((await gatewayLeague()).includes("unavailable"), false);
});
