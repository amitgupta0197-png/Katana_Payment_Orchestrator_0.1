// Integration health verdict (lib/integration-health-rules).

import { test } from "node:test";
import assert from "node:assert/strict";
import { verdict } from "@/lib/integration-health-rules";

const api = (requests = 0, refused = 0, last_error: string | null = null) => ({ requests, refused, last_at: null, last_error });
const cb = (delivered = 0, retrying = 0, failed = 0, last_error: string | null = null) => ({ delivered, retrying, failed, last_delivered_at: null, last_error });

test("nothing sent and nothing received is idle, not healthy", () => {
  assert.deepEqual(verdict({ api: api(), callbacks: cb() }), { state: "IDLE", note: null });
});

test("accepted requests and delivered messages are OK", () => {
  assert.equal(verdict({ api: api(20), callbacks: cb(18) }).state, "OK");
});

test("a message given up on is failing, whatever else is fine", () => {
  const v = verdict({ api: api(20), callbacks: cb(18, 0, 2, "HTTP 500") });
  assert.equal(v.state, "FAILING");
  assert.match(v.note!, /2 payment messages could not reach your server \(HTTP 500\)/);
});

test("most requests refused is failing; a few refused is attention", () => {
  assert.equal(verdict({ api: api(10, 6, "INVALID_HASH"), callbacks: cb() }).state, "FAILING");
  const v = verdict({ api: api(10, 1, "INVALID_HASH"), callbacks: cb(5) });
  assert.equal(v.state, "ATTENTION");
  assert.match(v.note!, /1 API request was refused \(last: INVALID_HASH\)/);
});

test("a retry in progress is attention", () => {
  assert.equal(verdict({ api: api(3), callbacks: cb(2, 1) }).state, "ATTENTION");
});
