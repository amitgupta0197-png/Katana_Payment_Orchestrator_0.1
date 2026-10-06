// "Needs attention" ranking (lib/attention).
import { test } from "node:test";
import assert from "node:assert/strict";
import { attentionView, bankerHref, CATEGORY, ATTENTION_CATEGORIES, type AttentionItem } from "@/lib/attention";

const item = (over: Partial<AttentionItem>): AttentionItem => ({
  key: "K", category: "REFUSALS", bankerCode: "B1", bankerId: "id-1", merchantName: "M",
  title: "t", detail: "d", since: null, count: 1, fix: null, ...over,
});

test("worst first: a paid order the merchant wasn't told about comes before many refusals", () => {
  const v = attentionView([
    item({ key: "a", category: "REFUSALS", count: 50 }),
    item({ key: "b", category: "VERIFYING_STUCK" }),
    item({ key: "c", category: "PAID_NOT_TOLD" }),
    item({ key: "d", category: "REFUSES_LIVE" }),
  ], new Map());
  assert.deepEqual(v.items.map((i) => i.key), ["d", "c", "a", "b"]);
  assert.equal(v.items[0].categoryLabel, "Can't take live orders");
});

test("inside a category: more occurrences first, then the oldest", () => {
  const v = attentionView([
    item({ key: "x", category: "UNMATCHED_MONEY", count: 1, since: "2026-10-01T00:00:00Z" }),
    item({ key: "y", category: "UNMATCHED_MONEY", count: 3, since: "2026-10-05T00:00:00Z" }),
    item({ key: "z", category: "UNMATCHED_MONEY", count: 1, since: "2026-09-01T00:00:00Z" }),
  ], new Map());
  assert.deepEqual(v.items.map((i) => i.key), ["y", "z", "x"]);
});

test("a snoozed row is hidden and counted until its time is up; duplicates are shown once", () => {
  const now = new Date("2026-10-07T10:00:00Z");
  const items = [item({ key: "s", category: "CALLBACK_FAILING" }), item({ key: "s", category: "CALLBACK_FAILING" }), item({ key: "t" })];
  const hidden = attentionView(items, new Map([["s", "2026-10-08T10:00:00Z"]]), now);
  assert.deepEqual(hidden.items.map((i) => i.key), ["t"]);
  assert.equal(hidden.snoozed, 1);
  assert.equal(hidden.counts.CALLBACK_FAILING, 0);
  const expired = attentionView(items, new Map([["s", "2026-10-06T10:00:00Z"]]), now);
  assert.deepEqual(expired.items.map((i) => i.key), ["s", "t"]);
  assert.equal(expired.counts.CALLBACK_FAILING, 1);
});

test("every category has a label and a short, plain note", () => {
  for (const c of ATTENTION_CATEGORIES) {
    assert.ok(CATEGORY[c].label.length > 3);
    const words = CATEGORY[c].info.split(/\s+/).length;
    assert.ok(words <= 35, `${c} note has ${words} words`);
  }
  assert.equal(bankerHref("id-1", "B1", "intent"), "/bankers/id-1?tab=intent");
  assert.equal(bankerHref(null, "B 1"), "/bankers/B%201");
});
