// Onboarding gates and the stage history against a real database. Run with `pnpm test:integration`.
//
// IT WRITES ROWS, so it only runs against a local database (PG_HOST localhost / 127.0.0.1). It
// creates one banker and removes it, its documents and its gate results. The stage history is
// append-only by design, so the rows written there stay.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rows } from "@/lib/pg";
import {
  blockingGates, gateDocuments, gateScreening, listGates, recordGates, runStepGates, SUBJECT_COLS, type OnboardingSubject,
} from "@/lib/onboarding-gates";

const HOST = process.env.PG_HOST ?? "localhost";
const LOCAL = ["localhost", "127.0.0.1", "::1"].includes(HOST);
const opts = { skip: LOCAL ? false : `refusing to write to a non-local database (${HOST})` };
const CODE = `ITESTGATE${Date.now()}`;
let id = "";

const subject = async () => (await rows<OnboardingSubject>("merchant", `SELECT ${SUBJECT_COLS} FROM merchants WHERE id = $1::uuid`, [id]))[0];
const history = () => rows<{ from_stage: string | null; to_stage: string }>("merchant",
  "SELECT from_stage, to_stage FROM merchant_status_history WHERE merchant_id = $1::uuid ORDER BY id", [id]);

before(async () => {
  if (!LOCAL) return;
  id = (await rows<{ id: string }>("merchant", `
    INSERT INTO merchants (merchant_code, legal_name, contact_email, category_mcc, gstin, business_pan, director_name, director_pan, director_aadhaar_last4)
    VALUES ($1, 'Itest Gate Foods LLP', 'itest-gate@example.com', '5411', '27AAPFU0939F1ZV', 'AAPFU0939F', 'Itest Director', 'ABCPK1234L', '1234')
    RETURNING id::text`, [CODE]))[0].id;
});
after(async () => {
  if (LOCAL && id) {
    await rows("merchant", "DELETE FROM merchant_onboarding_gates WHERE merchant_id = $1::uuid", [id]);
    await rows("merchant", "DELETE FROM merchant_kyb_documents WHERE merchant_id = $1::uuid", [id]);
    await rows("merchant", "DELETE FROM merchants WHERE id = $1::uuid", [id]);
  }
  setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
});

test("every stage a banker is in is in its history, however the stage was changed", opts, async () => {
  assert.deepEqual(await history(), [{ from_stage: null, to_stage: "APPLICATION" }]);
  await rows("merchant", "UPDATE merchants SET stage = 'DOCS_PENDING' WHERE id = $1::uuid", [id]);
  await rows("merchant", "UPDATE merchants SET contact_phone = '9000000000' WHERE id = $1::uuid", [id]);   // not a stage change
  assert.deepEqual(await history(), [{ from_stage: null, to_stage: "APPLICATION" }, { from_stage: "APPLICATION", to_stage: "DOCS_PENDING" }]);
  await assert.rejects(rows("merchant", "DELETE FROM merchant_status_history WHERE merchant_id = $1::uuid", [id]), /append-only/);
});

test("only the last four Aadhaar digits can be stored", opts, async () => {
  await assert.rejects(rows("merchant", "UPDATE merchants SET director_aadhaar_last4 = '123456789012' WHERE id = $1::uuid", [id]), /merchants_aadhaar_last4_chk/);
});

test("the documents gate lists what is missing, and passes once they are uploaded", opts, async () => {
  let g = await gateDocuments(await subject());
  assert.deepEqual([g.result, g.detail.missing], ["REVIEW", ["PAN", "GST", "BANK_STATEMENT"]]);
  for (const t of ["PAN", "GST", "BANK_STATEMENT"])
    await rows("merchant", `INSERT INTO merchant_kyb_documents (merchant_id, doc_type, content_type, size_bytes, sha256, storage_ref)
                            VALUES ($1::uuid, $2, 'application/pdf', 1, 'itest', 'itest')`, [id, t]);
  g = await gateDocuments(await subject());
  assert.deepEqual([g.result, g.detail.missing], ["PASS", []]);
});

test("a name on the sanctions list fails screening; a clean one on a small list is for review, not a pass", opts, async (t) => {
  const listed = (await rows<{ full_name: string }>("riskVelocity", "SELECT full_name FROM sanctions_list LIMIT 1").catch(() => []))[0]?.full_name;
  const clean = await gateScreening(await subject());
  assert.equal(clean.result === "PASS" || clean.result === "REVIEW", true);
  if ((clean.detail.list_entries as number) < 100) assert.match(clean.summary, /only \d+ entries/);
  if (!listed) return t.skip("the local sanctions list is empty");
  const hit = await gateScreening({ ...(await subject()), director_name: listed });
  assert.equal(hit.result, "FAIL");
  assert.match(hit.summary, /sanctions list match/);
});

test("the application step runs its two gates; results are recorded, and an override names who allowed it", opts, async () => {
  // No website: reviewed, never fetched, so the test needs no network.
  const gates = await runStepGates("step_application", { ...(await subject()), website: null });
  assert.deepEqual(gates.map((g) => [g.gate, g.result]), [["APPLICATION", "PASS"], ["WEBSITE", "REVIEW"]]);
  assert.deepEqual(blockingGates(gates, false), []);
  await recordGates(id, gates);

  const bad = await runStepGates("step_application", { ...(await subject()), website: null, category_mcc: "7995" });
  assert.deepEqual(blockingGates(bad, false).map((g) => g.gate), ["APPLICATION"]);
  await recordGates(id, bad, "ops@itest");

  const log = await listGates(id);
  assert.equal(log.length, 4);
  assert.deepEqual(log.map((g) => [g.gate, g.result, g.operator, g.overridden_by]), [
    ["WEBSITE", "REVIEW", "SYSTEM", null], ["APPLICATION", "FAIL", "SYSTEM", "ops@itest"],
    ["WEBSITE", "REVIEW", "SYSTEM", null], ["APPLICATION", "PASS", "SYSTEM", null],
  ]);
  assert.match(String(log[1].detail.summary), /prohibited category/);
  assert.deepEqual(await runStepGates("step_bank_verify", await subject()), []);
});
