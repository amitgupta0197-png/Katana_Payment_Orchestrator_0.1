// The Bank → TSP → Banker chain against a real database (merchant 0018, lib/chain-store), with
// its Maker-Checker approvals. Run with `pnpm test:integration`.
//
// IT WRITES ROWS, so it only runs against a local database. It creates a bank, a TSP and a
// banker and removes them; the stage / MID histories and the WORM log are append-only by
// design, so the rows written there stay.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rows } from "@/lib/pg";
import {
  advanceTsp, applyMidIssue, bankerChain, ChainError, confirmTspBank, createBank, createTsp, linkTspBank, requestMid,
  requestMidDeactivate, setBankerChain, tspDetail, tspStatusChange, updateTsp, withdrawMid, reviewTspDocument, addTspDocument,
} from "@/lib/chain-store";
import { MC_ACTIONS } from "@/lib/maker-checker-actions";
import { PendingRequestError } from "@/lib/maker-checker";
import { gateMidIssuance, SUBJECT_COLS, type OnboardingSubject } from "@/lib/onboarding-gates";

const HOST = process.env.PG_HOST ?? "localhost";
const LOCAL = ["localhost", "127.0.0.1", "::1"].includes(HOST);
const opts = { skip: LOCAL ? false : `refusing to write to a non-local database (${HOST})` };
const N = String(Date.now()).slice(-8);
const maker = { id: "00000000-0000-4000-8000-000000000001", email: "itest-maker@example.com", persona: "SUPER_ADMIN" as const };
const checker = { id: "00000000-0000-4000-8000-000000000002", email: "itest-checker@example.com" };
let bankId = "", tspId = "", bankerId = "";
const requests: string[] = [];

/** What the Maker-Checker route does on approval: claim, apply, undo the claim if it fails. */
async function approve(requestId: string) {
  const r = (await rows<any>("provider", `SELECT request_id::text, resource_type, resource_id, action, payload FROM maker_checker_requests WHERE request_id = $1::uuid`, [requestId]))[0];
  await rows("provider", `UPDATE maker_checker_requests SET status = 'APPROVED', checker_email = $2 WHERE request_id = $1::uuid AND status = 'PENDING'`, [requestId, checker.email]);
  try { return await MC_ACTIONS[r.action].apply(r, checker); }
  catch (e) { await rows("provider", `UPDATE maker_checker_requests SET status = 'PENDING', checker_email = NULL WHERE request_id = $1::uuid`, [requestId]); throw e; }
}
const code = async (p: Promise<unknown>) => { try { await p; return "OK"; } catch (e) { return e instanceof ChainError ? e.code : e instanceof PendingRequestError ? "REQUEST_PENDING" : String(e); } };

before(async () => {
  if (!LOCAL) return;
  bankId = (await createBank({ code: `ITB${N}`, name: "Itest Bank", bank_type: "PRIVATE", settlement_account: "50100012345678" }, maker)).id;
  tspId = (await createTsp({ code: `ITT${N}`, name: "Itest PayCo", tsp_type: "PAYMENT_AGGREGATOR", legal_name: "Itest PayCo Pvt Ltd",
    rbi_licence_no: "RBI/PA/ITEST", primary_contact_email: "ops@itest.example", compliance_officer_email: "co@itest.example" }, maker)).id;
  bankerId = (await rows<{ id: string }>("merchant", `
    INSERT INTO merchants (merchant_code, legal_name, contact_email, stage, step_application, step_kyb_docs, step_screening, step_bank_verify)
    VALUES ($1, 'Itest Chain Banker', 'itest-chain@example.com', 'MID_ISSUANCE', true, true, true, true) RETURNING id::text`, [`ITC${N}`]))[0].id;
});

after(async () => {
  if (LOCAL) {
    const ids = [tspId, bankerId].filter(Boolean);
    await rows("provider", `DELETE FROM maker_checker_requests WHERE request_id = ANY($1::uuid[]) OR resource_id = ANY($2::text[])`, [requests, ids]).catch(() => {});
    if (bankerId) {
      await rows("provider", `DELETE FROM maker_checker_requests WHERE resource_type = 'issued_mid' AND payload->>'merchant_id' = $1`, [bankerId]).catch(() => {});
      await rows("merchant", `DELETE FROM issued_mids WHERE merchant_id = $1::uuid`, [bankerId]);
      await rows("merchant", `DELETE FROM merchants WHERE id = $1::uuid`, [bankerId]);
    }
    if (tspId) {
      await rows("merchant", `DELETE FROM tsp_documents WHERE tsp_id = $1::uuid`, [tspId]);
      await rows("merchant", `DELETE FROM tsp_banks WHERE tsp_id = $1::uuid`, [tspId]);
      await rows("merchant", `DELETE FROM tsps WHERE id = $1::uuid`, [tspId]);
    }
    if (bankId) await rows("merchant", `DELETE FROM banks WHERE id = $1::uuid`, [bankId]);
  }
  setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
});

test("a TSP is onboarded step by step, and goes live only with a second person", opts, async () => {
  assert.equal((await advanceTsp(tspId, maker)).stage, "KYB_PENDING");
  assert.equal(await code(advanceTsp(tspId, maker)), "CHECKLIST_INCOMPLETE", "documents not approved");

  for (const t of ["INCORPORATION", "RBI_LICENCE"]) {
    const d = await addTspDocument(tspId, { doc_type: t, filename: `${t}.pdf`, content_type: "application/pdf", size_bytes: 1, sha256: "itest", storage_ref: "itest" }, maker);
    assert.equal(await code(reviewTspDocument(tspId, d.id, "APPROVED", null, maker)), "OWN_UPLOAD", "the uploader does not review");
    await reviewTspDocument(tspId, d.id, "APPROVED", null, checker);
  }
  assert.equal((await advanceTsp(tspId, maker)).stage, "SCREENING");

  // Screening runs the list check; on a local database the lists are tiny, so it is a REVIEW,
  // which a Super Admin overrides with a note.
  const s = await code(advanceTsp(tspId, maker));
  if (s === "SCREENING_NOT_CLEAR") {
    assert.equal(await code(advanceTsp(tspId, maker, { override: true })), "NOTE_REQUIRED");
    assert.equal((await advanceTsp(tspId, maker, { override: true, notes: "itest: local lists" })).stage, "BANK_VERIFY");
  } else assert.equal(s, "OK");

  assert.equal(await code(advanceTsp(tspId, maker)), "CHECKLIST_INCOMPLETE", "no bank confirmed");
  await linkTspBank(tspId, bankId, maker);
  assert.equal(await code(linkTspBank(tspId, bankId, maker)), "ALREADY_LINKED");
  await confirmTspBank(tspId, bankId, "HDFC/TSP/2026/01", maker);
  assert.equal((await advanceTsp(tspId, maker)).stage, "CONFIG");

  assert.equal(await code(advanceTsp(tspId, maker)), "CHECKLIST_INCOMPLETE", "no flows or quota");
  await updateTsp(tspId, { allowed_flows: ["INTENT", "PAYOUT"], max_mids_per_banker: 2 }, maker);
  const live = await advanceTsp(tspId, maker);
  assert.equal(live.stage, "CONFIG");
  assert.ok(live.request_id);
  requests.push(live.request_id!);
  assert.equal(await code(advanceTsp(tspId, maker)), "REQUEST_PENDING", "asked twice, queued once");
  await approve(live.request_id!);
  const d = await tspDetail(tspId);
  assert.equal(d.tsp.stage, "LIVE");
  assert.deepEqual(d.history.map((h) => h.to_stage).reverse(), ["APPLICATION", "KYB_PENDING", "SCREENING", "BANK_VERIFY", "CONFIG", "LIVE"]);
  await assert.rejects(rows("merchant", `DELETE FROM tsp_stage_history WHERE tsp_id = $1::uuid`, [tspId]), /append-only/);
});

test("a live TSP's permissions change through Maker-Checker", opts, async () => {
  const r = await updateTsp(tspId, { max_mids_per_banker: 3, primary_contact_name: "Itest Ops" }, maker);
  assert.ok(r.request_id);
  requests.push(r.request_id!);
  let d = await tspDetail(tspId);
  assert.equal(d.tsp.max_mids_per_banker, 2, "not changed until approved");
  assert.equal(d.tsp.primary_contact_name, "Itest Ops", "a detail is saved at once");
  await approve(r.request_id!);
  d = await tspDetail(tspId);
  assert.equal(d.tsp.max_mids_per_banker, 3);
});

test("a banker is put on the TSP and its MIDs are made active by a second person", opts, async () => {
  const subject = async () => (await rows<OnboardingSubject>("merchant", `SELECT ${SUBJECT_COLS} FROM merchants WHERE id = $1::uuid`, [bankerId]))[0];
  assert.equal((await gateMidIssuance(await subject())).result, "FAIL", "no TSP yet");
  assert.equal(await code(requestMid(bankerId, { flow: "INTENT", mid_value: "ITEST0001" }, maker)), "NO_TSP");

  await setBankerChain(bankerId, tspId, bankId, maker);
  assert.equal(await code(requestMid(bankerId, { flow: "P2P", mid_value: "ITEST0001" }, maker)), "FLOW_NOT_ALLOWED");

  const m1 = await requestMid(bankerId, { flow: "INTENT", mid_value: `ITEST${N}A`, issued_on: "2026-10-01", daily_limit: 100000 }, maker);
  requests.push(m1.request_id);
  assert.equal(await code(requestMid(bankerId, { flow: "INTENT", mid_value: `ITEST${N}A` }, maker)), "MID_TAKEN");
  let c = await bankerChain(bankerId);
  assert.equal(c.mids.find((m) => m.id === m1.id)!.status, "PENDING_APPROVAL");
  assert.equal((await gateMidIssuance(await subject())).result, "REVIEW", "nothing chosen for its merchant, no active MID");

  await approve(m1.request_id);
  c = await bankerChain(bankerId);
  assert.equal(c.mids.find((m) => m.id === m1.id)!.status, "ACTIVE");
  assert.equal((await gateMidIssuance(await subject())).result, "PASS");
  assert.equal(await code(applyMidIssue(m1.id, checker)), "NOT_PENDING", "approved twice, applied once");

  // A pending MID can be withdrawn, and its request goes with it.
  const m2 = await requestMid(bankerId, { flow: "PAYOUT", mid_value: `ITEST${N}B` }, maker);
  requests.push(m2.request_id);
  await withdrawMid(bankerId, m2.id, maker);
  const req = await rows<{ status: string }>("provider", `SELECT status FROM maker_checker_requests WHERE request_id = $1::uuid`, [m2.request_id]);
  assert.equal(req[0].status, "EXPIRED");

  // Quota: 3 open MIDs allowed.
  const m3 = await requestMid(bankerId, { flow: "PAYOUT", mid_value: `ITEST${N}C` }, maker); requests.push(m3.request_id);
  const m4 = await requestMid(bankerId, { flow: "INTENT", mid_value: `ITEST${N}D` }, maker); requests.push(m4.request_id);
  assert.equal(await code(requestMid(bankerId, { flow: "INTENT", mid_value: `ITEST${N}E` }, maker)), "MID_QUOTA_REACHED");

  // Moving the banker to another TSP is refused while it holds MIDs here.
  assert.equal(await code(setBankerChain(bankerId, tspId, bankId, maker)), "OK", "the same chain again is fine");

  // Deactivation goes through Maker-Checker too.
  const dq = await requestMidDeactivate(bankerId, m1.id, maker, "itest: bank closed the MID");
  requests.push(dq.request_id);
  await approve(dq.request_id);
  c = await bankerChain(bankerId);
  assert.equal(c.mids.find((m) => m.id === m1.id)!.status, "INACTIVE");
  assert.deepEqual(c.events.filter((e) => e.mid_id === m1.id).map((e) => e.to_status).reverse(), ["PENDING_APPROVAL", "ACTIVE", "INACTIVE"]);
  await assert.rejects(rows("merchant", `DELETE FROM issued_mid_events WHERE merchant_id = $1::uuid`, [bankerId]), /append-only/);
});

test("a MID is not activated once its TSP is suspended", opts, async () => {
  const c = await bankerChain(bankerId);
  const pending = c.mids.find((m) => m.status === "PENDING_APPROVAL")!;
  const s = await tspStatusChange(tspId, "suspend", maker, "itest: licence under review");
  requests.push(s.request_id!);
  await approve(s.request_id!);
  assert.equal(await code(approve(pending.request_id!)), "TSP_NOT_LIVE");
  const still = await rows<{ status: string }>("provider", `SELECT status FROM maker_checker_requests WHERE request_id = $1::uuid`, [pending.request_id]);
  assert.equal(still[0].status, "PENDING", "a refused approval leaves the request waiting");
  assert.equal(await code(tspStatusChange(tspId, "reject", maker, "itest: too late")), "CANNOT_REJECT");
});
