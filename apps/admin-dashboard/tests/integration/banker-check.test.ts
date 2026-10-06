// "Check this banker" (lib/banker-check-store) against the local database: the facts are read with
// the order path's own functions, the answer is shaped for the screen, and nothing is written but
// the grandfathered live-activation row the order path itself would record. Run with
// `pnpm test:integration`; it reads TEST_BANKER (default M10001), and only runs against a local
// database. An exclusive partner's banker is refused, as createKatanaOrder refuses it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { rows } from "@/lib/pg";
import { bankerCheckFacts, checkBankerById } from "@/lib/banker-check-store";

const HOST = process.env.PG_HOST ?? "localhost";
const LOCAL = ["localhost", "127.0.0.1", "::1"].includes(HOST);
const opts = { skip: LOCAL ? false : `refusing to run against a non-local database (${HOST})` };
const BANKER = process.env.TEST_BANKER ?? "M10001";

test("checks a banker by code and by id, in the screen's shape", opts, async () => {
  const id = (await rows<{ id: string }>("merchant", `SELECT id::text FROM merchants WHERE merchant_code = $1`, [BANKER]))[0]?.id;
  assert.ok(id, `no banker ${BANKER} in the local database`);
  const byCode = await checkBankerById(BANKER);
  const byId = await checkBankerById(id);
  assert.ok(byCode && byId);
  assert.equal(byCode.facts.code, BANKER);
  assert.equal(byId.facts.code, BANKER);
  for (const r of [byCode.result, byId.result]) {
    assert.equal(typeof r.ready, "boolean");
    assert.equal(r.ready, r.blockers.length === 0);
    assert.match(r.headline, new RegExp(BANKER));
    for (const i of [...r.blockers, ...r.notes, ...r.passed]) assert.ok(i.key && i.title && typeof i.detail === "string");
  }
  assert.equal(await bankerCheckFacts("no-such-banker-zz"), null);
});

test("an exclusive partner's banker is refused with PARTNER_ONLY", opts, async () => {
  const f = await bankerCheckFacts(BANKER);
  assert.ok(f);
  if (!f.partnerExclusive) {
    // The rule is the same either way: check it with the real facts and the flag set.
    const { checkBanker } = await import("@/lib/banker-check");
    const r = checkBanker({ ...f, partnerExclusive: true, partnerName: "Test partner" });
    assert.ok(r.blockers.some((b) => b.key === "PARTNER_ONLY"));
    assert.equal(r.ready, false);
  } else {
    const r = (await checkBankerById(BANKER))!.result;
    assert.ok(r.blockers.some((b) => b.key === "PARTNER_ONLY"));
  }
});
