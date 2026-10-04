// Channel accounting (vendorGateway 0039, provider 0020): the channel lock, reconciliation states
// in SQL against the pure rule, settlements applied inside their channel, and banker-side
// chargebacks matched, ruled on, debited and reversed inside the pay-in's channel.
// Run with `pnpm test:integration`. IT WRITES ROWS, so it only runs against a local database and
// removes what it created.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rows } from "@/lib/pg";
import { createKatanaOrder, confirmKatanaOrder } from "@/lib/katana-order";
import { setProviderFlow } from "@/lib/payin-flow-store";
import { reconBaseSql } from "@/lib/channel-accounts";
import { outstandingByChannel } from "@/lib/branch-settlement";
import {
  approveChargeback, chargebackChain, chargebackProblems, ChargebackError, createCbRule, dismissChargeback,
  evaluateChargeback, getChargeback, ingestChargeback, reverseChargeback,
} from "@/lib/chargebacks-store";
import { merchantChargeback } from "@/lib/chargeback-view";

const HOST = process.env.PG_HOST ?? "localhost";
const LOCAL = ["localhost", "127.0.0.1", "::1"].includes(HOST);
const opts = { skip: LOCAL ? false : `refusing to write to a non-local database (${HOST})` };
const PROVIDER = process.env.TEST_PROVIDER_ID ?? "a0000000-0000-0000-0000-000000000001";
const BANKER = process.env.TEST_BANKER ?? "M10001";
const BY = "integration-test-cb@local";
const R = String(Date.now()).slice(-8);
const PREFIX = "ITEST-CB-";
let n = 0;

async function cleanup() {
  // Postings and events are append-only by trigger; the test lifts the guard on its own rows only.
  await rows("vendorGateway", `ALTER TABLE payin_chargeback_postings DISABLE TRIGGER payin_chargeback_postings_locked_trg`);
  await rows("vendorGateway", `ALTER TABLE payin_chargeback_events DISABLE TRIGGER payin_chargeback_events_locked_trg`);
  try {
    await rows("vendorGateway", `DELETE FROM payin_chargeback_postings WHERE chargeback_id IN (SELECT id FROM payin_chargebacks WHERE received_by = $1)`, [BY]);
    await rows("vendorGateway", `DELETE FROM payin_chargeback_events WHERE chargeback_id IN (SELECT id FROM payin_chargebacks WHERE received_by = $1)`, [BY]);
  } finally {
    await rows("vendorGateway", `ALTER TABLE payin_chargeback_postings ENABLE TRIGGER payin_chargeback_postings_locked_trg`);
    await rows("vendorGateway", `ALTER TABLE payin_chargeback_events ENABLE TRIGGER payin_chargeback_events_locked_trg`);
  }
  await rows("vendorGateway", `DELETE FROM payin_chargebacks WHERE received_by = $1`, [BY]);
  await rows("vendorGateway", `DELETE FROM payin_chargeback_rules WHERE created_by = $1`, [BY]);
  await rows("vendorGateway", `DELETE FROM vendor_payin_orders WHERE order_id LIKE '${PREFIX}%'`);
  await rows("provider", `DELETE FROM provider_branch_settlements WHERE requested_by = $1`, [BY]);
}
before(async () => { if (LOCAL) await cleanup(); });
after(async () => {
  if (LOCAL) {
    await cleanup();
    await setProviderFlow(PROVIDER, { flow: "UNSET", by: BY });
    await rows("provider", "DELETE FROM provider_payin_flow_history WHERE changed_by = $1", [BY]);
    await rows("provider", "UPDATE providers SET payin_flow_set_by = NULL, payin_flow_set_at = NULL WHERE payin_flow_set_by = $1", [BY]);
  }
  setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
});

async function paidOrder(flow: "P2P" | "INTENT", amount: number, livemode: boolean, utr: string | null) {
  await setProviderFlow(PROVIDER, { flow, by: BY });
  const r = await createKatanaOrder({ orderId: `${PREFIX}${R}-${n++}`, amount, currency: "INR", merchantId: BANKER, livemode, flow });
  assert.equal(r.order.channel_type, flow);
  const c = await confirmKatanaOrder({ id: r.order.id, outcome: "SUCCESS", utr, evidence: utr ? "UTR" : "MANUAL", actor: BY, livemode });
  assert.equal(c.ok, true, c.error);
  return r.order;
}

const cb = (o: Partial<Parameters<typeof ingestChargeback>[0]>) =>
  ingestChargeback({ source: "BANK", bank_ref: `BCB${R}${n++}`, amount: 100, livemode: false, ...o }, BY);

test("a classified pay-in's channel can never be changed", opts, async () => {
  const o = await paidOrder("P2P", 101, false, `UTRLOCK${R}`);
  await assert.rejects(
    rows("vendorGateway", `UPDATE vendor_payin_orders SET channel_type = 'INTENT' WHERE id = $1::uuid`, [o.id]),
    /channel_type is final/);
});

test("the reconciliation state in SQL is the pure rule's: matched, missing evidence, pending", opts, async () => {
  const matched = await paidOrder("P2P", 102, false, `UTRM${R}`);
  const missing = await paidOrder("P2P", 103, false, null);
  await setProviderFlow(PROVIDER, { flow: "P2P", by: BY });
  const pending = (await createKatanaOrder({ orderId: `${PREFIX}${R}-${n++}`, amount: 104, currency: "INR", merchantId: BANKER, livemode: false, flow: "P2P" })).order;
  const r = await rows<{ id: string; recon: string; variance: number }>("vendorGateway",
    `${reconBaseSql("WHERE o.id = ANY($1::uuid[])")} SELECT id::text, recon, variance FROM base`, [[matched.id, missing.id, pending.id]]);
  const by = new Map(r.map((x) => [x.id, x]));
  assert.equal(by.get(matched.id)?.recon, "MATCHED");
  assert.equal(by.get(missing.id)?.recon, "MISSING_EXTERNAL");
  assert.equal(by.get(missing.id)?.variance, 103);
  assert.equal(by.get(pending.id)?.recon, "PENDING");
});

test("a settlement raised for one channel never settles the other channel's pay-ins", opts, async () => {
  const before = await outstandingByChannel(PROVIDER, BANKER);
  const a = await paidOrder("P2P", 250, true, `UTRSA${R}`);
  const b = await paidOrder("P2P", 150, true, `UTRSB${R}`);
  assert.ok(a && b);
  const mid = await outstandingByChannel(PROVIDER, BANKER);
  assert.equal(Math.round((mid.P2P.outstanding - before.P2P.outstanding) * 100) / 100, 400);

  const settle = (channel: string | null, amount: number) => rows("provider", `
    INSERT INTO provider_branch_settlements (provider_id, merchant_key, amount, status, channel_type, verified_at, requested_by)
    VALUES ($1::uuid, $2, $3, 'VERIFIED', $4, now(), $5)`, [PROVIDER, BANKER, amount, channel, BY]);
  // An INTENT settlement leaves the P2P pay-ins unsettled.
  await settle("INTENT", 10_000);
  const afterIntent = await outstandingByChannel(PROVIDER, BANKER);
  assert.equal(afterIntent.P2P.outstanding, mid.P2P.outstanding);
  // A P2P settlement of the whole P2P backlog covers it.
  await settle("P2P", mid.P2P.outstanding);
  const afterP2p = await outstandingByChannel(PROVIDER, BANKER);
  assert.equal(afterP2p.P2P.outstanding, 0);
});

test("with no rule a chargeback is matched in its channel and never debited", opts, async () => {
  const o = await paidOrder("INTENT", 500, false, `UTRCB1${R}`);
  const { chargeback, created } = await cb({ original_ref: `UTRCB1${R}`, amount: 500 });
  assert.equal(created, true);
  assert.deepEqual([chargeback.state, chargeback.order_id, chargeback.channel_type, chargeback.debited], ["CB_RULE_EXCEPTION", o.id, "INTENT", 0]);
  assert.deepEqual(chargebackProblems(chargeback), ["waiting for a rule or a person"]);

  // The same record twice is the same chargeback.
  const again = await ingestChargeback({ source: "BANK", bank_ref: chargeback.bank_ref, amount: 500, original_ref: `UTRCB1${R}`, livemode: false }, BY);
  assert.deepEqual([again.created, again.chargeback.id], [false, chargeback.id]);

  // A rule for this merchant's INTENT pay-ins, then the chargeback is ruled on again: debited in full.
  await createCbRule({ provider_id: PROVIDER, banker_code: null, channel_type: "INTENT", reason_code: null, debit_bps: 10_000, auto_debit: true, auto_max_amount: null, note: "itest" }, BY);
  const done = (await evaluateChargeback(chargeback.id, BY))!;
  // A decided chargeback is left alone by evaluate: it was RULE_EXCEPTION (open), so it is decided now.
  assert.deepEqual([done.state, done.debited, done.calculated_debit, done.rule_version], ["CB_DEBIT_POSTED", 500, 500, 1]);
  assert.deepEqual(chargebackProblems(done), []);
  const chain = await chargebackChain(chargeback.id);
  assert.deepEqual(chain.postings.map((p) => [p.kind, p.amount, p.debit_bps]), [["CHARGEBACK_DEBIT", 500, 10_000]]);
  assert.deepEqual(chain.events.map((e) => e.to_state), ["CB_PENDING_MATCH", "CB_RULE_EXCEPTION", "CB_DEBIT_POSTED"]);

  // The merchant view names no source and no person.
  const view = merchantChargeback(done, []);
  assert.equal(JSON.stringify(view).includes(BY), false);
  assert.equal(view.remaining_exposure, 0);

  // Postings are append-only.
  await assert.rejects(rows("vendorGateway", `UPDATE payin_chargeback_postings SET amount = 1 WHERE chargeback_id = $1::uuid`, [chargeback.id]), /append-only/);

  // A reversal is a new linked entry; the debit stays.
  const rev = (await reverseChargeback(chargeback.id, BY, { kind: "REPRESENTMENT_WON", note: "won at the bank" }))!;
  assert.deepEqual([rev.state, rev.debited, rev.reversed], ["CB_REVERSED", 500, 500]);
  const chain2 = await chargebackChain(chargeback.id);
  assert.deepEqual(chain2.postings.map((p) => p.kind), ["CHARGEBACK_DEBIT", "CHARGEBACK_REVERSAL"]);
  assert.equal(chain2.postings[1].reverses_id, chain2.postings[0].id);
  await assert.rejects(reverseChargeback(chargeback.id, BY, { kind: "RECOVERED", note: "again" }), (e) => e instanceof ChargebackError && e.code === "NOTHING_TO_REVERSE");
});

test("a chargeback is never matched across channels", opts, async () => {
  const o = await paidOrder("INTENT", 300, false, `UTRCB2${R}`);
  assert.ok(o);
  const { chargeback } = await cb({ original_ref: `UTRCB2${R}`, channel: "P2P", amount: 300 });
  assert.deepEqual([chargeback.state, chargeback.order_id], ["CB_MANUAL_REVIEW", null]);
  assert.match(chargeback.state_note ?? "", /Not matched across channels/);
  // A person cannot link it across channels either.
  await assert.rejects(evaluateChargeback(chargeback.id, BY, o.id), (e) => e instanceof ChargebackError && e.code === "CROSS_CHANNEL");
  assert.equal((await dismissChargeback(chargeback.id, BY, "the bank sent it for the wrong rail"))?.state, "CB_DISMISSED");
});

test("a partial rule debits its share; an amount above the pay-in goes to a person", opts, async () => {
  await createCbRule({ provider_id: PROVIDER, banker_code: null, channel_type: "P2P", reason_code: null, debit_bps: 5_000, auto_debit: true, auto_max_amount: null, note: "itest p2p half" }, BY);
  const o = await paidOrder("P2P", 400, false, `UTRCB3${R}`);
  const half = (await cb({ order_ref: o.order_id, amount: 400 })).chargeback;
  assert.deepEqual([half.state, half.debited, half.calculated_debit, half.match_method], ["CB_PARTIAL_DEBIT", 200, 200, "ORDER_ID"]);

  const o2 = await paidOrder("P2P", 50, false, `UTRCB4${R}`);
  const big = (await cb({ original_ref: `UTRCB4${R}`, amount: 80 })).chargeback;
  assert.deepEqual([big.state, big.order_id, big.debited], ["CB_MANUAL_REVIEW", o2.id, 0]);
  // A stated amount is a Super Admin's override (the route checks the persona); recorded as one.
  const ok = (await approveChargeback(big.id, BY, { amount: 50, note: "bank confirmed ₹50" }))!;
  assert.deepEqual([ok.state, ok.debited, ok.override], ["CB_PARTIAL_DEBIT", 50, true]);
  assert.deepEqual(chargebackProblems(ok), []);

  // A new rule for the same scope ends the old one and is the next version.
  const v2 = await createCbRule({ provider_id: PROVIDER, banker_code: null, channel_type: "P2P", reason_code: null, debit_bps: 10_000, auto_debit: true, auto_max_amount: null, note: "itest p2p full" }, BY);
  assert.equal(v2.version, 2);
  const ended = await rows<{ n: number }>("vendorGateway", `SELECT COUNT(*)::int AS n FROM payin_chargeback_rules
     WHERE created_by = $1 AND channel_type = 'P2P' AND (effective_to IS NULL OR effective_to > now())`, [BY]);
  assert.equal(ended[0].n, 1);
  // The decided chargeback keeps the rule version it was decided under.
  assert.equal((await getChargeback(half.id))?.rule_version, 1);
});
