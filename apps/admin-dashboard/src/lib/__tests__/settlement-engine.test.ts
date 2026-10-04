// The Settlement Engine's rules (lib/settlement-engine): cycles in IST, the paise arithmetic, the
// state machine, and that every journal it builds balances.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  configProblem, dueCycle, settlementAmounts, cycleGross, canMove, stateForBranchStatus, paiseOf,
  initiatedLines, settledLines, reversed, collectedLines, reserveReleaseLines, istDay, NO_RATE_CARD,
  type SettlementConfigBody, type RateCard,
} from "@/lib/settlement-engine";
import { journalProblem } from "@/lib/ledger";

const BODY: SettlementConfigBody = {
  timing: "T1", currency: "INR", min_payout_minor: 100_00, max_payout_minor: null,
  reserve_bps: 500, reserve_hold_days: 7, tds_bps: 200, beneficiary_id: "b1", transfer_mode: "IMPS",
};
const CARD: RateCard = { ...NO_RATE_CARD, id: "r1", version: 1, upline_bps: 50, katana_bps: 100, downline_bps: 50, gst_bps: 1800, fixed_fee_minor: 10_00 };
const ist = (s: string) => new Date(`${s}+05:30`);

test("config: a valid one passes; bad ones say why", () => {
  assert.equal(configProblem(BODY), null);
  assert.match(configProblem({ ...BODY, timing: "WEEKLY" }) ?? "", /weekday/);
  assert.match(configProblem({ ...BODY, reserve_bps: 500, reserve_hold_days: 0 }) ?? "", /hold period/);
  assert.match(configProblem({ ...BODY, transfer_mode: "RTGS" }) ?? "", /RTGS/);
  assert.match(configProblem({ ...BODY, currency: "USD" as "INR" }) ?? "", /INR/);
  assert.match(configProblem({ ...BODY, max_payout_minor: 50_00 }) ?? "", /above the minimum/);
});

test("cycles: T1 settles what was paid before today's IST midnight, from the run hour", () => {
  assert.equal(dueCycle(BODY, ist("2026-10-05T09:59:00")), null);
  const c = dueCycle(BODY, ist("2026-10-05T10:00:00"))!;
  assert.equal(c.key, "T1:2026-10-05");
  assert.equal(c.cutoff.toISOString(), ist("2026-10-05T00:00:00").toISOString());
  // Just after midnight UTC is still the same IST day.
  assert.equal(istDay(new Date("2026-10-04T19:00:00Z")), "2026-10-05");
});

test("cycles: T0 cuts at the run hour, T2 two days back, weekly on its weekday, instant every 5 minutes, on-demand never", () => {
  const t0 = dueCycle({ ...BODY, timing: "T0" }, ist("2026-10-05T22:30:00"))!;
  assert.equal(t0.cutoff.toISOString(), ist("2026-10-05T22:00:00").toISOString());
  assert.equal(dueCycle({ ...BODY, timing: "T0" }, ist("2026-10-05T21:00:00")), null);
  assert.equal(dueCycle({ ...BODY, timing: "T2" }, ist("2026-10-05T11:00:00"))!.cutoff.toISOString(), ist("2026-10-04T00:00:00").toISOString());
  // 2026-10-05 is a Monday (1).
  assert.equal(dueCycle({ ...BODY, timing: "WEEKLY", weekday: 1 }, ist("2026-10-05T11:00:00"))!.key, "WEEKLY:2026-10-05");
  assert.equal(dueCycle({ ...BODY, timing: "WEEKLY", weekday: 2 }, ist("2026-10-05T11:00:00")), null);
  const a = dueCycle({ ...BODY, timing: "INSTANT" }, new Date("2026-10-05T05:01:00Z"))!;
  const b = dueCycle({ ...BODY, timing: "INSTANT" }, new Date("2026-10-05T05:04:59Z"))!;
  assert.equal(a.key, b.key);
  assert.equal(dueCycle({ ...BODY, timing: "ON_DEMAND" }, new Date()), null);
});

test("amounts: layers, fixed fee, GST on charges, TDS added back, reserve withheld", () => {
  // ₹10,000.00 gross: layers 0.5% + 1% + 0.5% = ₹200, fixed ₹10 → charges ₹210; GST 18% = ₹37.80;
  // TDS 2% of ₹210 = ₹4.20; reserve 5% = ₹500 → net 10000 − 500 − 210 − 37.80 + 4.20 = ₹9,256.40.
  const a = settlementAmounts(10_000_00n, CARD, BODY);
  assert.equal(a.charges, 210_00n);
  assert.equal(a.gst, 37_80n);
  assert.equal(a.tds, 4_20n);
  assert.equal(a.reserve, 500_00n);
  assert.equal(a.net, 9_256_40n);
  assert.equal(a.gross - a.reserve - a.charges - a.gst + a.tds, a.net);
});

test("amounts: a max clamp scales the parts and keeps the total exact; a minimum alone becomes the fixed part", () => {
  const a = settlementAmounts(10_000_00n, { ...CARD, max_charge_minor: 100_00 }, { reserve_bps: 0, tds_bps: 0 });
  assert.equal(a.charges, 100_00n);
  assert.equal(a.upline + a.katana + a.downline + a.fixed, 100_00n);
  const m = settlementAmounts(100_00n, { ...NO_RATE_CARD, min_charge_minor: 5_00 }, { reserve_bps: 0, tds_bps: 0 });
  assert.equal(m.fixed, 5_00n);
  assert.throws(() => settlementAmounts(5_00n, { ...NO_RATE_CARD, min_charge_minor: 10_00 }, { reserve_bps: 0, tds_bps: 0 }), /nothing to settle/);
});

test("cycle gross: payable less what came after the cut-off, capped, nothing under the minimum", () => {
  assert.equal(cycleGross(5_000_00n, 1_000_00n, BODY), 4_000_00n);
  assert.equal(cycleGross(5_000_00n, 1_000_00n, { ...BODY, max_payout_minor: 3_000_00 }), 3_000_00n);
  assert.equal(cycleGross(150_00n, 100_00n, BODY), 0n);
  assert.equal(cycleGross(100_00n, 200_00n, BODY), 0n);
});

test("every journal the engine builds balances, and its reversal balances too", () => {
  const a = settlementAmounts(10_000_00n, CARD, BODY);
  for (const lines of [initiatedLines("B1", a), settledLines("B1", a.net), collectedLines("B1", 123n), reserveReleaseLines("B1", a.reserve)]) {
    assert.equal(journalProblem(lines), null);
    assert.equal(journalProblem(reversed(lines)), null);
  }
});

test("states: the happy path, holds return where they came from, finals stay final", () => {
  assert.ok(canMove("PENDING", "INITIATED"));
  assert.ok(canMove("INITIATED", "IN_TRANSIT"));
  assert.ok(canMove("IN_TRANSIT", "SETTLED"));
  assert.ok(canMove("SETTLED", "REVERSED"));
  assert.ok(!canMove("SETTLED", "FAILED"));
  assert.ok(canMove("HELD", "IN_TRANSIT", "IN_TRANSIT"));
  assert.ok(!canMove("HELD", "SETTLED", "IN_TRANSIT"));
  assert.ok(!canMove("HELD", "INITIATED", "IN_TRANSIT"));
  assert.ok(!canMove("FAILED", "INITIATED"));
  assert.equal(stateForBranchStatus("UTR_SUBMITTED"), "IN_TRANSIT");
  assert.equal(stateForBranchStatus("VERIFIED"), "SETTLED");
  assert.equal(stateForBranchStatus("REJECTED"), "FAILED");
  assert.equal(stateForBranchStatus("ACCEPTED"), null);
});

test("paise from rupees, exactly", () => {
  assert.equal(paiseOf("499.99"), 49999n);
  assert.equal(paiseOf(1), 100n);
  assert.equal(paiseOf("0.1"), 10n);
  assert.equal(paiseOf("2.005"), 201n);
});
