// The health engine against a real database (merchant 0020, lib/health-store). `pnpm test:integration`.
//
// IT WRITES ROWS, so it only runs against a local database. It creates one banker and removes it
// and its cache rows; health_checklist_completions is append-only by design, so its rows stay.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rows } from "@/lib/pg";
import { completions, computeActor, computeAll, readCached } from "@/lib/health-store";

const HOST = process.env.PG_HOST ?? "localhost";
const LOCAL = ["localhost", "127.0.0.1", "::1"].includes(HOST);
const opts = { skip: LOCAL ? false : `refusing to write to a non-local database (${HOST})` };
const CODE = `ITH${String(Date.now()).slice(-8)}`;
let id = "";

before(async () => {
  if (!LOCAL) return;
  id = (await rows<{ id: string }>("merchant", `
    INSERT INTO merchants (merchant_code, legal_name, contact_email, stage, step_bank_verify)
    VALUES ($1, 'Itest Health Banker', 'itest-health@example.com', 'CONFIG', false) RETURNING id::text`, [CODE]))[0].id;
});

after(async () => {
  if (!LOCAL) return;
  await rows("merchant", `DELETE FROM actor_health WHERE actor_id = $1 OR actor_id LIKE $2`, [id, `${CODE}:%`]);
  await rows("merchant", `DELETE FROM merchants WHERE id = $1::uuid`, [id]);
});

test("a banker's health is computed, cached, and a step done is recorded once", opts, async () => {
  const first = await computeActor("BANKER", id);
  assert.ok(first);
  assert.equal(first!.live, false);
  assert.equal(first!.items.find((i) => i.key === "bank_verify")?.state, "MISSING");
  const [cached] = await readCached("BANKER", [id]);
  assert.equal(cached.band, first!.band);
  assert.equal(cached.stale, false);
  assert.deepEqual(await completions("BANKER", id), [], "a first computation records nothing");

  await rows("merchant", `UPDATE merchants SET step_bank_verify = true WHERE id = $1::uuid`, [id]);
  const second = await computeActor("BANKER", id);
  assert.equal(second!.items.find((i) => i.key === "bank_verify")?.state, "DONE");
  const done = await completions("BANKER", id);
  assert.equal(done.length, 1);
  assert.equal(done[0].item_key, "bank_verify");
  assert.equal(done[0].method, "SYSTEM_AUTO");
  await computeActor("BANKER", id);
  assert.equal((await completions("BANKER", id)).length, 1, "recomputing records nothing new");
});

test("completions are append-only", opts, async () => {
  await assert.rejects(rows("merchant", `UPDATE health_checklist_completions SET completed_by = 'x' WHERE actor_id = $1`, [id]), /append-only/);
  await assert.rejects(rows("merchant", `DELETE FROM health_checklist_completions WHERE actor_id = $1`, [id]), /append-only/);
});

test("unknown actors are null; computeAll covers every kind", opts, async () => {
  assert.equal(await computeActor("BANKER", "00000000-0000-4000-8000-00000000dead"), null);
  assert.equal(await computeActor("TSP", "not-a-uuid"), null);
  const all = await computeAll();
  assert.ok(all.counts.BANKER >= 1);
  assert.ok(all.results.some((r) => r.type === "BANKER" && r.id === id));
  for (const r of all.results) {
    assert.ok(r.score >= 0 && r.score <= 100);
    if (r.band === "BLOCKED") assert.equal(r.score, 0);
  }
});
