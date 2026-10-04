// Which settlement covered an order (lib/banker-settled): settlements apply oldest first, inside
// the order's own channel, and a settlement with no channel covers what the channel ones left.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCoverage, settlementCovering, type BankerSettlement, type SettlementChannel } from "@/lib/banker-settled";

const s = (amount: number, utr: string, channel: SettlementChannel = null, banker = "B1"): BankerSettlement =>
  ({ banker, channel, amount, utr, at: "2026-09-01T00:00:00.000Z" });
const bankerOf = new Map([["B1", "B1"], ["U1", "B1"]]);
const rest = (cum: number | null) => ({ channel: "P2P", by_channel: false, cum_ch: null, cum_rest: cum });

test("an order is covered by the first settlement whose running total reaches it", () => {
  const cover = buildCoverage([s(350, "UTR-A"), s(250, "UTR-B")], bankerOf);
  assert.equal(settlementCovering(cover, "B1", rest(100))?.utr, "UTR-A");
  assert.equal(settlementCovering(cover, "U1", rest(300))?.utr, "UTR-A");   // the banker's uuid key is the same banker
  assert.equal(settlementCovering(cover, "B1", rest(350))?.utr, "UTR-A");
  assert.equal(settlementCovering(cover, "B1", rest(600))?.utr, "UTR-B");
});

test("an order past what the banker has settled, or of an unknown banker, is not covered", () => {
  const cover = buildCoverage([s(350, "UTR-A"), s(250, "UTR-B")], bankerOf);
  assert.equal(settlementCovering(cover, "B1", rest(600.01)), null);
  assert.equal(settlementCovering(cover, "B2", rest(10)), null);
  assert.equal(settlementCovering(cover, null, rest(10)), null);
  assert.equal(settlementCovering(cover, "B1", rest(null)), null);
});

test("a channel settlement is a queue of its own, and totals are kept per channel", () => {
  const cover = buildCoverage([s(100, "I-1", "INTENT"), s(40, "P-1", "P2P"), s(500, "ANY")], bankerOf);
  assert.deepEqual(
    cover.chBankers.map((b, i) => `${b}:${cover.chChannels[i]}:${cover.chTotals[i]}`).sort(),
    ["B1:INTENT:100", "B1:P2P:40"]);
  assert.deepEqual(cover.restBankers, ["B1"]);
  assert.deepEqual(cover.restTotals, [500]);
  // An INTENT order covered inside its channel names the INTENT settlement…
  assert.equal(settlementCovering(cover, "B1", { channel: "INTENT", by_channel: true, cum_ch: 80, cum_rest: 0 })?.utr, "I-1");
  // …a P2P one the P2P settlement, never the INTENT one…
  assert.equal(settlementCovering(cover, "B1", { channel: "P2P", by_channel: true, cum_ch: 40, cum_rest: 0 })?.utr, "P-1");
  // …and one the channel settlements did not reach is covered by the one with no channel.
  assert.equal(settlementCovering(cover, "B1", { channel: "P2P", by_channel: false, cum_ch: 90, cum_rest: 50 })?.utr, "ANY");
});
