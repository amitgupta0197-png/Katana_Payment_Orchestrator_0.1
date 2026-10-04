// The MID switch's rules (lib/mid-switch) and what its screens show (lib/mid-switch-view).

import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseMid, healthOf, inWindow, istClock, validateMidLimits, whyNot, DEFAULT_SETTINGS, type Candidate, type Mid } from "@/lib/mid-switch";
import { actorWords, eventWords, midViewRow } from "@/lib/mid-switch-view";

const mid = (o: Partial<Mid>): Mid => ({
  id: "m1", banker_code: "B1", kind: "UPI", name: "upi-1", vault_label: null, upi_id: "a@upi", payee_name: null,
  priority: 1, weight: 1, status: "ACTIVE", status_reason: null, min_amount: null, max_amount: null, daily_amount: null,
  daily_count: null, monthly_amount: null, active_from: null, active_to: null, active_days: null, skip_unhealthy: true,
  health_min_success: null, ...o,
});
const cand = (m: Partial<Mid>, u: Partial<Candidate["usage"]> = {}, h: Partial<Candidate["health"]> = {}): Candidate => ({
  mid: mid(m), usage: { day_amount: 0, day_count: 0, month_amount: 0, ...u }, health: { ended: 0, paid: 0, recent_create_failures: 0, ...h },
});
// 2026-10-05 is a Monday; 10:00 IST = 04:30 UTC.
const MON_10 = new Date("2026-10-05T04:30:00Z");

test("India time and the hours a MID takes traffic, including a window across midnight", () => {
  assert.deepEqual(istClock(MON_10), { minutes: 600, weekday: 1 });
  assert.equal(inWindow(mid({ active_from: "09:00", active_to: "18:00" }), MON_10), true);
  assert.equal(inWindow(mid({ active_from: "18:00", active_to: "09:00" }), MON_10), false);
  const mon23 = new Date("2026-10-05T17:30:00Z"), tue02 = new Date("2026-10-05T20:30:00Z");
  assert.equal(inWindow(mid({ active_from: "22:00", active_to: "06:00" }), mon23), true);
  // 02:00 Tuesday belongs to Monday night's window.
  assert.equal(inWindow(mid({ active_from: "22:00", active_to: "06:00", active_days: [1] }), tue02), true);
  assert.equal(inWindow(mid({ active_days: [6, 7] }), MON_10), false);
  assert.equal(inWindow(mid({}), MON_10), true);
});

test("every reason a MID cannot take an order", () => {
  const w = (m: Partial<Mid>, u = {}, h = {}, amount = 500) => whyNot(cand(m, u, h), amount, MON_10).why;
  assert.deepEqual(w({}), []);
  assert.match(w({ status: "PAUSED", status_reason: "bank asked" })[0], /paused \(bank asked\)/);
  assert.match(w({ max_amount: 100 })[0], /over its maximum/);
  assert.match(w({ min_amount: 1000 })[0], /under its minimum/);
  assert.match(w({ daily_amount: 1000 }, { day_amount: 600 })[0], /today's limit/);
  assert.deepEqual(w({ daily_amount: 1000 }, { day_amount: 500 }), [], "exactly at the limit still fits");
  assert.match(w({ daily_count: 3 }, { day_count: 3 })[0], /3 orders are used/);
  assert.match(w({ monthly_amount: 10_000 }, { month_amount: 9_800 })[0], /month's limit/);
  assert.match(w({ active_from: "20:00", active_to: "23:00" })[0], /outside its hours/);
  assert.match(w({}, {}, { ended: 20, paid: 2 })[0], /unhealthy/);
  assert.deepEqual(w({ skip_unhealthy: false }, {}, { ended: 20, paid: 2 }), [], "a MID set not to be skipped keeps taking traffic");
  assert.match(w({}, {}, { recent_create_failures: 3 })[0], /could not be created/);
});

test("health needs enough orders before it judges", () => {
  assert.equal(healthOf(mid({}), { ended: 5, paid: 0, recent_create_failures: 0 }).state, "UNKNOWN");
  assert.equal(healthOf(mid({}), { ended: 10, paid: 1, recent_create_failures: 0 }).state, "UNHEALTHY");
  assert.equal(healthOf(mid({}), { ended: 10, paid: 3, recent_create_failures: 0 }).state, "HEALTHY");
  assert.equal(healthOf(mid({ health_min_success: 50 }), { ended: 10, paid: 3, recent_create_failures: 0 }).state, "UNHEALTHY");
});

test("priority: the first MID that can take the order, the next when it cannot", () => {
  const a = cand({ id: "a", name: "A", priority: 1, daily_count: 2 }, { day_count: 2 });
  const b = cand({ id: "b", name: "B", priority: 2 });
  const c = cand({ id: "c", name: "C", priority: 3 });
  const r = chooseMid([c, a, b], DEFAULT_SETTINGS, 100, MON_10);
  assert.equal(r.chosen?.id, "b");
  assert.equal(r.how, "PRIORITY");
  assert.match(r.reason, /skipped A \(today's 2 orders are used\)/);
  assert.equal(chooseMid([a, b, c], DEFAULT_SETTINGS, 100, MON_10, { exclude: ["b"] }).chosen?.id, "c", "a MID that just failed is skipped");
  // Equal priority: the one used less today.
  const x = cand({ id: "x", name: "X", priority: 1 }, { day_amount: 900 }), y = cand({ id: "y", name: "Y", priority: 1 }, { day_amount: 100 });
  assert.equal(chooseMid([x, y], DEFAULT_SETTINGS, 100, MON_10).chosen?.id, "y");
});

test("the manual switch wins while its MID can take the order", () => {
  const a = cand({ id: "a", name: "A", priority: 1 }), b = cand({ id: "b", name: "B", priority: 2, max_amount: 200 });
  const pinned = { ...DEFAULT_SETTINGS, pinned_mid_id: "b", pinned_until: null };
  assert.deepEqual([chooseMid([a, b], pinned, 100, MON_10).chosen?.id, chooseMid([a, b], pinned, 100, MON_10).how], ["b", "MANUAL"]);
  const over = chooseMid([a, b], pinned, 500, MON_10);
  assert.equal(over.chosen?.id, "a", "an order the pinned MID cannot take goes by the rule");
  assert.match(over.reason, /switched to by hand cannot take it/);
  const expired = { ...pinned, pinned_until: "2026-10-05T04:00:00Z" };
  assert.equal(chooseMid([a, b], expired, 100, MON_10).chosen?.id, "a", "an expired manual switch is over");
});

test("weighted split follows the weights, and none at all refuses", () => {
  const a = cand({ id: "a", name: "A", weight: 70 }), b = cand({ id: "b", name: "B", weight: 30 }), z = cand({ id: "z", name: "Z", weight: 0 });
  const weighted = { ...DEFAULT_SETTINGS, mode: "WEIGHTED" as const };
  assert.equal(chooseMid([a, b, z], weighted, 100, MON_10, { random: () => 0.1 }).chosen?.id, "a");
  assert.equal(chooseMid([a, b, z], weighted, 100, MON_10, { random: () => 0.75 }).chosen?.id, "b");
  let hits = 0;
  for (let i = 0; i < 100; i++) if (chooseMid([a, b, z], weighted, 100, MON_10, { random: () => i / 100 }).chosen?.id === "a") hits++;
  assert.equal(hits, 70);
  assert.equal(chooseMid([z], weighted, 100, MON_10, { random: () => 0.5 }).chosen?.id, "z", "only zero weights left: still taken");
  const none = chooseMid([cand({ status: "PAUSED" })], DEFAULT_SETTINGS, 100, MON_10);
  assert.deepEqual([none.chosen, none.how], [null, "NONE"]);
});

test("limits that contradict each other are refused", () => {
  assert.match(validateMidLimits({ min_amount: 500, max_amount: 100 })!, /minimum is above/);
  assert.match(validateMidLimits({ max_amount: 5000, daily_amount: 1000 })!, /above the day's/);
  assert.match(validateMidLimits({ daily_amount: 5000, monthly_amount: 1000 })!, /above the month's/);
  assert.match(validateMidLimits({ active_from: "09:00" })!, /both/);
  assert.match(validateMidLimits({ active_days: [0] })!, /1 \(Monday\)/);
  assert.equal(validateMidLimits({ min_amount: 1, max_amount: 100, daily_amount: 1000, monthly_amount: 10_000 }), null);
});

test("a merchant never sees a processor's name, MID code or who at Katana acted", () => {
  const m = { ...mid({ kind: "GATEWAY", name: "PayU account 2", vault_label: "gateway_mid:x", upi_id: null, status_reason: "Razorpay outage" }),
    status: "PAUSED" as const, usage: { day_amount: 0, day_count: 0, month_amount: 0 }, health: { ended: 0, paid: 0, recent_create_failures: 0 } };
  const v = midViewRow(m, { staff: false, settings: { ...DEFAULT_SETTINGS }, now: MON_10, account: { gateway: "PAYU", env: "PROD" } });
  const text = JSON.stringify(v);
  assert.equal(/payu|razorpay/i.test(text), false, text);
  assert.equal(v.gateway, null);
  assert.equal(midViewRow(m, { staff: true, settings: { ...DEFAULT_SETTINGS }, now: MON_10, account: { gateway: "PAYU", env: "PROD" } }).gateway, "PAYU");
  assert.equal(actorWords("katana:ops@katana.in", false), "Katana operations");
  assert.equal(actorWords("switch", false), "Automatic");
  assert.equal(/payu/i.test(eventWords({ action: "AUTO_SWITCH", detail: { from: "PayU 1", to: "PayU 2", from_why_not: ["paused"] } }, false)), false);
});
