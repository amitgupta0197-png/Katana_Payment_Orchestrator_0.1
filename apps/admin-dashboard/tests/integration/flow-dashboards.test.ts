// Flow dashboards (/flows/*): the SQL of lib/flow-dashboards-store, -p2p, -payout and -health
// against seeded Intent / P2P pay-ins and payouts of one throwaway banker code.
// Run with `pnpm test:integration`. IT WRITES ROWS, so it only runs against a local database and
// removes what it created.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rows } from "@/lib/pg";
import { intentDashboard } from "@/lib/flow-dashboards-store";
import { p2pDashboard } from "@/lib/flow-dashboards-p2p";
import { payoutDashboard } from "@/lib/flow-dashboards-payout";
import { healthGrid } from "@/lib/flow-dashboards-health";

const HOST = process.env.PG_HOST ?? "localhost";
const LOCAL = ["localhost", "127.0.0.1", "::1"].includes(HOST);
const opts = { skip: LOCAL ? false : `refusing to write to a non-local database (${HOST})` };
const R = String(Date.now()).slice(-8);
const CODE = `ITEST-FD-${R}`;
const PREFIX = `ITEST-FD-${R}-`;

async function cleanup() {
  await rows("vendorGateway", `DELETE FROM vendor_payin_orders WHERE merchant_id LIKE 'ITEST-FD-%'`);
  await rows("fifo", `DELETE FROM fifo_orders WHERE merchant_id LIKE 'ITEST-FD-%'`);
}

let k = 0;
async function payin(channel: "INTENT" | "P2P", status: string, opts2: { livemode?: boolean; ageMin?: number; amount?: number } = {}) {
  const age = opts2.ageMin ?? 2;
  await rows("vendorGateway", `
    INSERT INTO vendor_payin_orders (vendor, order_id, amount, status, merchant_id, livemode, channel_type, channel_id, created_at, updated_at)
    VALUES ('KATANA', $1, $2, $3, $4, $5, $6, $7, now() - make_interval(mins => $8), now() - make_interval(mins => $8) + interval '2 minutes')`,
    [`${PREFIX}${k++}`, opts2.amount ?? 100, status, CODE, opts2.livemode ?? true, channel, channel === "INTENT" ? "PAYU" : "UPI", age]);
}

async function payout(status: string, extra: { rail?: string; reason?: string; amountMinor?: number } = {}) {
  await rows("fifo", `
    INSERT INTO fifo_orders (order_ref, merchant_id, direction, amount_minor, status, payout_rail, failure_reason, livemode, created_at, completed_at)
    VALUES ($1, $2, 'PAYOUT', $3, $4, $5, $6, true, now() - interval '3 minutes', CASE WHEN $4 IN ('COMPLETED','SETTLED') THEN now() - interval '1 minute' END)`,
    [`${PREFIX}PO${k++}`, CODE, extra.amountMinor ?? 50_000, status, extra.rail ?? null, extra.reason ?? null]);
}

before(async () => {
  if (!LOCAL) return;
  await cleanup();
  for (let i = 0; i < 8; i++) await payin("INTENT", "SUCCESS");
  await payin("INTENT", "FAILED"); await payin("INTENT", "FAILED");
  await payin("INTENT", "EXPIRED");
  await payin("INTENT", "PENDING");
  await payin("INTENT", "SUCCESS", { livemode: false });             // test mode: never in the live figures
  await payin("P2P", "SUCCESS");
  await payin("P2P", "EXPIRED");
  await payin("P2P", "PENDING", { ageMin: 45 });                      // stale: over 30 minutes, no credit
  await payout("COMPLETED", { rail: "IMPS", amountMinor: 100_000 });
  await payout("COMPLETED", { rail: "UPI", amountMinor: 20_000 });
  await payout("FAILED", { reason: "Insufficient balance" });
  await payout("QUEUED");
});
after(async () => { if (LOCAL) await cleanup(); });

test("Intent: KPIs, banker row, hourly rate and failure buckets for one banker", opts, async () => {
  const d = await intentDashboard(true, CODE);
  assert.equal(d.livemode, true);
  assert.equal(d.kpi.initiated, 12);
  assert.equal(d.kpi.paid, 8);
  assert.equal(d.kpi.failed, 2);
  assert.equal(d.kpi.expired, 1);
  assert.equal(d.kpi.pending, 1);
  assert.equal(d.kpi.success_rate, 0.7273);
  assert.ok(d.kpi.median_confirm_min != null && d.kpi.median_confirm_min > 0);
  assert.equal(d.bankers.length, 1);
  assert.equal(d.bankers[0].code, CODE);
  assert.equal(d.bankers[0].orders_24h, 12);
  assert.equal(d.bankers[0].state, "UNKNOWN");               // no merchants row for a throwaway code
  assert.equal(d.hourly.length, 24);
  assert.equal(d.hourly.reduce((s, h) => s + h.orders, 0), 12);
  const f = Object.fromEntries(d.failures.map((x) => [x.key, x.n]));
  assert.equal(f.FAILED_AT_GATEWAY, 2);
  assert.equal(f.EXPIRED_UNPAID, 1);
});

test("Intent: test mode sees only the test order", opts, async () => {
  const d = await intentDashboard(false, CODE);
  assert.equal(d.kpi.initiated, 1);
  assert.equal(d.kpi.paid, 1);
  assert.equal(d.kpi.create_failures, null);
});

test("P2P: deposits, stale pending and banker row", opts, async () => {
  const d = await p2pDashboard(true, CODE);
  assert.ok(d.kpi.deposits >= 2);                            // the 45-minute-old one may fall on yesterday near midnight
  assert.equal(d.kpi.credited, 1);
  assert.equal(d.recon.stale.count, 1);
  assert.equal(d.recon.stale.rows[0].banker, CODE);
  assert.ok(d.pending_by_expiry.overdue >= 1);
  assert.equal(d.bankers.find((b) => b.code === CODE)?.paid, 1);
});

test("Payouts: KPIs, mode split, failure reason and queue", opts, async () => {
  const d = await payoutDashboard(true, CODE);
  assert.equal(d.kpi.requests, 4);
  assert.equal(d.kpi.sent, 2);
  assert.equal(d.kpi.failed, 1);
  assert.equal(d.kpi.sent_amount, 1200);
  assert.ok(d.kpi.avg_settle_min != null && d.kpi.avg_settle_min > 1.5);
  const today = d.by_mode[d.by_mode.length - 1].modes;
  assert.equal(today.IMPS, 1000);
  assert.equal(today.UPI, 200);
  assert.equal(d.failures.find((f) => f.key === "INSUFFICIENT_FUNDS")?.n, 1);
  assert.equal(d.queue.length, 1);
  assert.equal(d.queue[0].open, 1);
  assert.equal(d.queue[0].open_amount, 500);
  assert.equal(d.queue[0].payable, 0);                       // no ledger account for the throwaway code
  assert.equal(d.queue[0].headroom, -500);
});

test("Health: the banker's Intent tile is red (27% failed with 12 orders), with an alert", opts, async () => {
  const g = await healthGrid(true, CODE);
  assert.equal(g.rows.length, 1);
  const t = g.rows[0].tiles;
  assert.equal(t.INTENT.orders_1h, 12);
  assert.equal(t.INTENT.tone, "bad");
  assert.equal(t.P2P.tone, "warn");                          // 1 of 2 ended failed, too few orders to be red
  assert.equal(t.PAYOUT.queue, 1);
  assert.ok(g.alerts.some((a) => a.code === CODE && a.flow === "INTENT"));
});
