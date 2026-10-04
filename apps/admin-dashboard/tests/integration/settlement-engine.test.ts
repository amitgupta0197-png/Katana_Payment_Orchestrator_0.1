// The Settlement Engine on the real databases (settlement 0002, ledger 0004, provider 0021,
// lib/settlement-engine-store): a two-person config, a settlement raised once however often it is
// asked, the banker's request followed through paid → verified, the reserve released, a rejected
// request reversed, and a T+1 cycle raised once. Every amount is checked on the ledger.
// Run with `pnpm test:integration`. IT WRITES ROWS, so it only runs against a local database; its
// own rows are removed at the end (ledger and event rows under their maintenance switches).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { db, rows } from "@/lib/pg";
import { postJournal } from "@/lib/ledger";
import { collectedLines, type SettlementConfigBody } from "@/lib/settlement-engine";
import {
  bankerBalances, decideConfig, followRequests, proposeConfig, raiseInstruction, releaseReserves, runDueCycles,
  getInstruction, SettlementError,
} from "@/lib/settlement-engine-store";

const HOST = process.env.PG_HOST ?? "localhost";
const LOCAL = ["localhost", "127.0.0.1", "::1"].includes(HOST);
const opts = { skip: LOCAL ? false : `refusing to write to a non-local database (${HOST})` };
const PROVIDER = process.env.TEST_PROVIDER_ID ?? "a0000000-0000-0000-0000-000000000001";
const B = process.env.TEST_BANKER ?? "M10001";
const R = `ITEST-SE-${Date.now().toString(36)}`;
const MAKER = `${R}-maker@local`, CHECKER = `${R}-checker@local`;
let beneficiary = "", rule = "";
const instructionIds: string[] = [];

const collect = (rupees: number, n: number, daysAgo = 2) => postJournal({
  journal_type: "payin.collected", narration: "itest pay-in", currency: "INR", idempotency_key: `${R}-collect-${n}`,
  ref: { type: "itest", id: R }, value_at: new Date(Date.now() - daysAgo * 864e5), lines: collectedLines(B, BigInt(rupees * 100)),
});
const reqOf = async (instr: string) => (await rows<{ id: string; status: string; amount: string; gross_amount: string }>("provider",
  `SELECT id::text, status, amount::text, gross_amount::text FROM provider_branch_settlements WHERE instruction_id = $1::uuid`, [instr]))[0];
const setReq = (instr: string, status: string, utr: string | null = null) =>
  rows("provider", `UPDATE provider_branch_settlements SET status = $2, utr = COALESCE($3, utr) WHERE instruction_id = $1::uuid`, [instr, status, utr]);

const BODY: SettlementConfigBody = {
  timing: "ON_DEMAND", currency: "INR", min_payout_minor: 100_00, max_payout_minor: null,
  reserve_bps: 500, reserve_hold_days: 7, tds_bps: 200, beneficiary_id: null, transfer_mode: "IMPS", allow_on_demand: true,
};

async function cleanup() {
  const ids = (await rows<{ id: string }>("settlement", `SELECT id::text FROM settlement_instructions WHERE banker_code = $1 AND created_by LIKE $2`, [B, `${R}%`])).map((r) => r.id);
  instructionIds.push(...ids.filter((i) => !instructionIds.includes(i)));
  const holds = (await rows<{ id: string }>("settlement", `SELECT id::text FROM settlement_reserve_holds WHERE instruction_id = ANY($1::uuid[])`, [instructionIds])).map((r) => r.id);
  const lc = await db("ledger").connect();
  try {
    await lc.query("BEGIN"); await lc.query("SET LOCAL ledger.maintenance = 'on'");
    const keys = [`${R}%`, ...instructionIds.map((i) => `settle:${i}:%`), ...holds.map((h) => `reserve:${h}:%`)];
    await lc.query(`DELETE FROM ledger_lines WHERE journal_id IN (SELECT id FROM journal_entries WHERE idempotency_key LIKE ANY($1))`, [keys]);
    await lc.query(`DELETE FROM journal_entries WHERE idempotency_key LIKE ANY($1)`, [keys]);
    await lc.query("COMMIT");
  } finally { lc.release(); }
  const sc = await db("settlement").connect();
  try {
    await sc.query("BEGIN"); await sc.query("SET LOCAL settlement.maintenance = 'on'");
    await sc.query(`DELETE FROM settlement_instruction_events WHERE instruction_id = ANY($1::uuid[])`, [instructionIds]);
    await sc.query(`DELETE FROM settlement_reserve_holds WHERE instruction_id = ANY($1::uuid[])`, [instructionIds]);
    await sc.query(`DELETE FROM settlement_instructions WHERE id = ANY($1::uuid[])`, [instructionIds]);
    await sc.query(`DELETE FROM settlement_configs WHERE banker_code = $1 AND maker LIKE $2`, [B, `${R}%`]);
    await sc.query("COMMIT");
  } finally { sc.release(); }
  await rows("provider", `DELETE FROM provider_branch_settlements WHERE instruction_id = ANY($1::uuid[])`, [instructionIds]);
  if (beneficiary) await rows("provider", `DELETE FROM provider_beneficiary_accounts WHERE id = $1::uuid`, [beneficiary]);
  if (rule) await rows("provider", `DELETE FROM provider_settlement_rules WHERE id = $1::uuid`, [rule]);
}

before(async () => {
  if (!LOCAL) return;
  const active = await rows("settlement", `SELECT 1 FROM settlement_configs WHERE banker_code = $1 AND state IN ('ACTIVE','PENDING_APPROVAL')`, [B]);
  if (active.length) throw new Error(`${B} already has a settlement config on this database; the test would change it`);
  beneficiary = (await rows<{ id: string }>("provider", `
    INSERT INTO provider_beneficiary_accounts (provider_id, label, beneficiary_name, account_number, ifsc, bank_name, transfer_mode, active)
    VALUES ($1::uuid, $2, 'ITest Merchant', '000111222333', 'HDFC0000001', 'HDFC Bank', 'IMPS', true) RETURNING id::text`, [PROVIDER, R]))[0].id;
  rule = (await rows<{ id: string }>("provider", `
    INSERT INTO provider_settlement_rules (provider_id, merchant_key, upline_bps, katana_bps, downline_bps, fixed_fee, gst_bps, currency, effective_from, version, reason, created_by)
    VALUES ($1::uuid, $2, 50, 100, 50, 10, 1800, 'INR', now() - interval '1 hour', 1, $3, $3) RETURNING id::text`, [PROVIDER, B, R]))[0].id;
});
after(async () => {
  if (LOCAL) await cleanup();
  setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
});

test("config: the maker cannot approve their own change; a second person can", opts, async () => {
  const c = await proposeConfig(B, { ...BODY, beneficiary_id: beneficiary }, MAKER, "itest");
  assert.equal(c.state, "PENDING_APPROVAL");
  await assert.rejects(decideConfig(c.id, MAKER, true, null), (e: unknown) => e instanceof SettlementError && e.code === "SELF_APPROVAL");
  const ok = await decideConfig(c.id, CHECKER, true, "looks right");
  assert.equal(ok.state, "ACTIVE");
});

test("a settlement is raised once, with the rate card, GST, TDS and reserve, and the ledger moves exactly", opts, async () => {
  await collect(10_000, 1);
  const before = await bankerBalances(B);
  const i = (await raiseInstruction({ banker: B, kind: "ON_DEMAND", amount_minor: 10_000_00n, actor: `${R}-staff`, key: "one" }))!;
  instructionIds.push(i.id);
  assert.equal(i.state, "INITIATED");
  // ₹10,000: charges ₹210 (0.5% + 1% + 0.5% + ₹10), GST ₹37.80, TDS ₹4.20, reserve ₹500 → net ₹9,256.40.
  assert.equal(i.net_minor, "925640");
  const again = await raiseInstruction({ banker: B, kind: "ON_DEMAND", amount_minor: 10_000_00n, actor: `${R}-staff`, key: "one" });
  assert.equal(again!.id, i.id);
  const after = await bankerBalances(B);
  assert.equal(before.payable - after.payable, 10_000_00n);
  assert.equal(after.in_transit - before.in_transit, 9_256_40n);
  assert.equal(after.reserve - before.reserve, 500_00n);
  const req = await reqOf(i.id);
  assert.equal(req.status, "REQUESTED");
  assert.equal(Number(req.amount), 9256.4);
  assert.equal(Number(req.gross_amount), 9500);       // covers the collections of gross less reserve
});

test("more than is available is refused", opts, async () => {
  await assert.rejects(raiseInstruction({ banker: B, kind: "ON_DEMAND", amount_minor: 99_999_999_00n, actor: `${R}-staff`, key: "too-much" }),
    (e: unknown) => e instanceof SettlementError && e.code === "INSUFFICIENT_BALANCE");
});

test("the banker pays (UTR) and the merchant verifies: in transit, then settled, and the money leaves the banker", opts, async () => {
  const id = instructionIds[0];
  const before = await bankerBalances(B);
  await setReq(id, "PAID", "UTR-ITEST-1");
  await followRequests(`${R}-cron`);
  let i = (await getInstruction(id))!;
  assert.equal(i.state, "IN_TRANSIT");
  assert.equal(i.utr, "UTR-ITEST-1");
  await setReq(id, "VERIFIED");
  await followRequests(`${R}-cron`);
  i = (await getInstruction(id))!;
  assert.equal(i.state, "SETTLED");
  const after = await bankerBalances(B);
  assert.equal(before.in_transit - after.in_transit, 9_256_40n);
  assert.equal(before.held_by_banker - after.held_by_banker, 9_256_40n);
  // The trigger-written history has every step.
  const ev = await rows<{ to_state: string }>("settlement", `SELECT to_state FROM settlement_instruction_events WHERE instruction_id = $1::uuid ORDER BY id`, [id]);
  assert.deepEqual(ev.map((e) => e.to_state), ["PENDING", "INITIATED", "IN_TRANSIT", "SETTLED"]);
});

test("the reserve is released back to payable when its hold ends", opts, async () => {
  const before = await bankerBalances(B);
  const r = await releaseReserves(new Date(Date.now() + 8 * 864e5));
  assert.ok(r.released >= 1);
  const after = await bankerBalances(B);
  assert.equal(before.reserve - after.reserve, 500_00n);
  assert.equal(after.payable - before.payable, 500_00n);
});

test("a rejected request fails the settlement and puts the money back", opts, async () => {
  await collect(1_000, 2);
  const before = await bankerBalances(B);
  const i = (await raiseInstruction({ banker: B, kind: "ON_DEMAND", amount_minor: 1_000_00n, actor: `${R}-staff`, key: "two" }))!;
  instructionIds.push(i.id);
  await setReq(i.id, "REJECTED");
  await followRequests(`${R}-cron`);
  assert.equal((await getInstruction(i.id))!.state, "FAILED");
  const after = await bankerBalances(B);
  assert.equal(after.payable, before.payable);
  assert.equal(after.in_transit, before.in_transit);
  assert.equal(after.reserve, before.reserve);
});

test("a T+1 cycle raises once, for what was paid before today", opts, async () => {
  const c = await proposeConfig(B, { ...BODY, timing: "T1", run_hour_ist: 0, beneficiary_id: beneficiary }, MAKER, "itest T1");
  await decideConfig(c.id, CHECKER, true, null);
  await collect(300, 3, 0);   // paid now: after today's cut-off, so it waits
  const before = await bankerBalances(B);
  const first = await runDueCycles(new Date(), `${R}-cron`);
  const second = await runDueCycles(new Date(), `${R}-cron`);
  assert.equal(second.raised, 0);
  const made = await rows<{ id: string; gross_minor: string }>("settlement",
    `SELECT id::text, gross_minor::text FROM settlement_instructions WHERE banker_code = $1 AND kind = 'SCHEDULED' AND created_by = $2`, [B, `${R}-cron`]);
  instructionIds.push(...made.map((m) => m.id));
  // The ₹500 reserve released above is payable and was paid before the cut-off: it is raised.
  assert.equal(first.raised, 1);
  assert.equal(made.length, 1);
  assert.equal(BigInt(made[0].gross_minor), before.payable - 300_00n);
});
