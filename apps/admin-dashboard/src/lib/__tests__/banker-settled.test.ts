// Which settlement covered an order (lib/banker-settled): settlements apply oldest first.

import { test } from "node:test";
import assert from "node:assert/strict";
import { settlementCovering, type BankerCoverage } from "@/lib/banker-settled";

const s = (amount: number, utr: string) => ({ banker: "B1", amount, utr, at: "2026-09-01T00:00:00.000Z" });
const cover: BankerCoverage = {
  keys: ["B1", "U1"], keyBanker: ["B1", "B1"], bankers: ["B1"], totals: [600],
  settlements: new Map([["B1", [s(350, "UTR-A"), s(250, "UTR-B")]]]),
  bankerOf: new Map([["B1", "B1"], ["U1", "B1"]]),
};

test("an order is covered by the first settlement whose running total reaches it", () => {
  assert.equal(settlementCovering(cover, "B1", 100)?.utr, "UTR-A");
  assert.equal(settlementCovering(cover, "U1", 300)?.utr, "UTR-A");   // the banker's uuid key is the same banker
  assert.equal(settlementCovering(cover, "B1", 350)?.utr, "UTR-A");
  assert.equal(settlementCovering(cover, "B1", 600)?.utr, "UTR-B");
});

test("an order past what the banker has settled, or of an unknown banker, is not covered", () => {
  assert.equal(settlementCovering(cover, "B1", 600.01), null);
  assert.equal(settlementCovering(cover, "B2", 10), null);
  assert.equal(settlementCovering(cover, null, 10), null);
  assert.equal(settlementCovering(cover, "B1", null), null);
});
