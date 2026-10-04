// The banker switch's rules (lib/banker-switch): the order a merchant's bankers are offered an order in.

import { test } from "node:test";
import assert from "node:assert/strict";
import { activePin, bankerOrder, defaultMember, passOverWords, DEFAULT_BANKER_SWITCH, type BankerMember, type BankerSwitchSettings } from "@/lib/banker-switch";

const NOW = new Date("2026-10-05T04:30:00Z");
const m = (banker_code: string, o: Partial<BankerMember> = {}): BankerMember => ({ ...defaultMember(banker_code), ...o });
const on = (o: Partial<BankerSwitchSettings> = {}): BankerSwitchSettings => ({ ...DEFAULT_BANKER_SWITCH, enabled: true, ...o });
const names = (c: { banker: string }[]) => c.map((x) => x.banker);

test("PRIORITY: lowest number first, ties to fewer orders today, then by code", () => {
  const members = [m("C", { priority: 5 }), m("A", { priority: 10 }), m("B", { priority: 5 })];
  assert.deepEqual(names(bankerOrder(members, on(), NOW)), ["B", "C", "A"]);
  assert.deepEqual(names(bankerOrder(members, on(), NOW, { ordersToday: { B: 9, C: 2 } })), ["C", "B", "A"]);
  assert.ok(bankerOrder(members, on(), NOW).every((c) => c.how === "PRIORITY"));
});

test("out of rotation is never offered an order, unless it is the banker switched to", () => {
  const members = [m("A"), m("B", { in_rotation: false })];
  assert.deepEqual(names(bankerOrder(members, on(), NOW)), ["A"]);
  const pinned = bankerOrder(members, on({ pinned_banker: "B" }), NOW);
  assert.deepEqual(names(pinned), ["B", "A"]);
  assert.equal(pinned[0].how, "PINNED");
});

test("a pin lasts until its time, and only for one of the merchant's bankers", () => {
  const s = on({ pinned_banker: "B", pinned_until: "2026-10-05T05:00:00Z" });
  assert.equal(activePin(s, ["A", "B"], NOW), "B");
  assert.equal(activePin(s, ["A", "B"], new Date("2026-10-05T05:00:01Z")), null);
  assert.equal(activePin(on({ pinned_banker: "Z" }), ["A", "B"], NOW), null);
  assert.deepEqual(names(bankerOrder([m("A"), m("B")], s, new Date("2026-10-05T06:00:00Z"))), ["A", "B"]);
});

test("WEIGHTED: drawn by weight without repeats; weight 0 takes none", () => {
  const members = [m("A", { weight: 1 }), m("B", { weight: 3 }), m("C", { weight: 0 })];
  // r = 0.0 lands on the first, r just under 1 on the last of what is left.
  assert.deepEqual(names(bankerOrder(members, on({ mode: "WEIGHTED" }), NOW, { random: () => 0 })), ["A", "B"]);
  assert.deepEqual(names(bankerOrder(members, on({ mode: "WEIGHTED" }), NOW, { random: () => 0.99 })), ["B", "A"]);
  // About three in four orders go to B first.
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let b = 0;
  for (let i = 0; i < 4000; i++) if (bankerOrder(members, on({ mode: "WEIGHTED" }), NOW, { random: rnd })[0].banker === "B") b++;
  assert.ok(b > 2800 && b < 3200, `B first ${b} of 4000`);
});

test("nobody in rotation: an empty order (the signer keeps its own order)", () => {
  assert.deepEqual(bankerOrder([m("A", { in_rotation: false })], on(), NOW), []);
});

test("why a banker was passed over, in words", () => {
  assert.equal(passOverWords("NO_KEY"), "has no Key for this mode");
  assert.equal(passOverWords("LIMIT"), "is over a pay-in limit");
  assert.equal(passOverWords("SOMETHING_NEW"), "could not take the order");
});
