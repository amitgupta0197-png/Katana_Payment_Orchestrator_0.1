// Workflows against a real database (merchant 0021, lib/workflow-store): instances follow the real
// banker / TSP state and Maker-Checker requests, people complete manual steps by role, and the
// actor itself is never changed. Run with `pnpm test:integration`.
//
// IT WRITES ROWS, so it only runs against a local database. It creates a banker, a TSP and a test
// template and removes them (the step events with `workflow.maintenance`).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { db, rows } from "@/lib/pg";
import {
  applyTemplateVersion, completeStep, escalateStep, instanceDetail, listInstances, listTemplates, OpenInstanceError, proposeTemplateVersion,
  rejectInstance, startInstance, syncInstance, WorkflowError,
} from "@/lib/workflow-store";
import { templateProblems, type StepDef } from "@/lib/workflow";
import { resolveAlert } from "@/lib/ops-alert";

const HOST = process.env.PG_HOST ?? "localhost";
const LOCAL = ["localhost", "127.0.0.1", "::1"].includes(HOST);
const opts = { skip: LOCAL ? false : `refusing to write to a non-local database (${HOST})` };
const N = String(Date.now()).slice(-8);
const TKEY = `itest_${N}`;
let bankerId = "", bankerCode = "", tspId = "";
const instances: string[] = [];
const requests: string[] = [];

const code = async (p: Promise<unknown>) => { try { await p; return "OK"; } catch (e) { return e instanceof WorkflowError ? e.code : String(e); } };
const status = async (id: string) => (await rows<{ status: string; current_step_id: string | null }>("merchant",
  `SELECT status, current_step_id FROM workflow_instances WHERE id = $1::uuid`, [id]))[0];
const start = async (key: string, actor: string, by = "itest@example.com") => { const r = await startInstance(key, actor, by); instances.push(r.id); return r.id; };
const mc = async (action: string, resource: string, st: string) => {
  const r = await rows<{ request_id: string }>("provider", `
    INSERT INTO maker_checker_requests (resource_type, resource_id, action, payload, maker_id, maker_email, status, created_at)
    VALUES ('tsp', $1, $2, '{}'::jsonb, 'itest', 'itest@example.com', $3, clock_timestamp()) RETURNING request_id::text`, [resource, action, st]);
  requests.push(r[0].request_id);
  return r[0].request_id;
};

before(async () => {
  if (!LOCAL) return;
  bankerCode = `IWF${N}`;
  bankerId = (await rows<{ id: string }>("merchant", `
    INSERT INTO merchants (merchant_code, legal_name, contact_email, stage, step_application)
    VALUES ($1, 'Itest Workflow Banker', 'itest-wf@example.com', 'DOCS_PENDING', true) RETURNING id::text`, [bankerCode]))[0].id;
  tspId = (await rows<{ id: string }>("merchant", `
    INSERT INTO tsps (code, name, tsp_type, stage) VALUES ($1, 'Itest WF PayCo', 'PAYMENT_AGGREGATOR', 'CONFIG') RETURNING id::text`, [`IWT${N}`]))[0].id;
});

after(async () => {
  if (!LOCAL) return;
  const c = await db("merchant").connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL workflow.maintenance = 'on'");
    const ids = (await c.query(`SELECT id FROM workflow_instances WHERE actor_id = ANY($1::text[]) OR template_key = $2`, [[bankerId, tspId], TKEY])).rows.map((r) => r.id);
    await c.query(`DELETE FROM workflow_step_events WHERE instance_id = ANY($1::uuid[])`, [ids]);
    await c.query(`DELETE FROM workflow_instances WHERE id = ANY($1::uuid[])`, [ids]);
    await c.query(`DELETE FROM workflow_templates WHERE key = $1`, [TKEY]);
    await c.query("COMMIT");
  } finally { c.release(); }
  await rows("provider", `DELETE FROM maker_checker_requests WHERE request_id = ANY($1::uuid[]) OR resource_id = ANY($2::text[])`, [requests, [tspId, TKEY]]).catch(() => {});
  await rows("checkout", `DELETE FROM merchant_checkout_keys WHERE merchant_code = $1`, [bankerCode]).catch(() => {});
  for (const i of instances) await resolveAlert(`workflow:escalated:${i}:request`).catch(() => {});
  await rows("audit", `DELETE FROM ops_alerts WHERE alert_key LIKE ANY($1::text[])`, [instances.map((i) => `workflow:%${i}%`)]).catch(() => {});
  if (bankerId) await rows("merchant", `DELETE FROM merchants WHERE id = $1::uuid`, [bankerId]).catch(() => {});
  if (tspId) await rows("merchant", `DELETE FROM tsps WHERE id = $1::uuid`, [tspId]).catch(() => {});
});

test("the six pre-built templates are valid", opts, async () => {
  const t = await listTemplates();
  for (const k of ["tsp_onboarding", "banker_onboarding", "merchant_onboarding", "mid_issuance", "key_rotation", "banker_suspension"]) {
    const x = t.find((y) => y.key === k);
    assert.ok(x, `${k} seeded`);
    assert.deepEqual(templateProblems(x!), [], k);
  }
});

test("banker onboarding follows the banker's real stage, and one instance per banker", opts, async () => {
  const id = await start("banker_onboarding", bankerId);
  assert.deepEqual(await status(id), { status: "IN_PROGRESS", current_step_id: "kyb_docs" });   // application already done
  assert.equal(await code(startInstance("banker_onboarding", bankerId, "x")), "ALREADY_OPEN");
  await rows("merchant", `UPDATE merchants SET stage = 'SCREENING', step_kyb_docs = true WHERE id = $1::uuid`, [bankerId]);
  await syncInstance(id);
  assert.equal((await status(id)).current_step_id, "screening");
  await syncInstance(id);   // idempotent
  assert.equal((await status(id)).current_step_id, "screening");
  // A manual-capable step can't be completed once the system has moved on; a system step never by hand.
  assert.equal(await code(completeStep(id, "screening", { email: "a@x", persona: "SUPER_ADMIN" })), "AUTOMATIC_STEP");
  await rows("merchant", `UPDATE merchants SET stage = 'LIVE', step_config = true WHERE id = $1::uuid`, [bankerId]);
  await syncInstance(id);
  assert.equal((await status(id)).status, "COMPLETED");
  const d = await instanceDetail(id, { persona: "OPERATOR" });
  assert.ok(d.steps.every((s) => s.state === "DONE"));
  assert.ok(d.events.some((e) => e.event === "COMPLETED" && e.method === "SYSTEM_AUTO"));
});

test("Key + Salt rotation: roles, checklist, four eyes, and the new key retires the old", opts, async () => {
  const id = await start("key_rotation", bankerId);
  const support = { email: "s@x", persona: "SUPPORT" };
  assert.equal(await code(completeStep(id, "request", support, { checklist: { reason: true } })), "CHECKLIST_INCOMPLETE");
  assert.equal(await code(completeStep(id, "request", { email: "f@x", persona: "FINANCE" }, { checklist: { reason: true, banker_told: true } })), "WRONG_ROLE");
  await completeStep(id, "request", support, { checklist: { reason: true, banker_told: true }, comment: "leaked in a screenshot" });
  await completeStep(id, "maker_rotate", { email: "a@x", persona: "SUPER_ADMIN" }, { checklist: { generated: true, handed_over: true } });
  assert.equal(await code(completeStep(id, "checker_approve", { email: "a@x", persona: "SUPER_ADMIN" }, { checklist: { verified: true } })), "SAME_PERSON");
  // Sent back: it returns to the maker.
  await completeStep(id, "checker_approve", { email: "b@x", persona: "SUPER_ADMIN" }, { outcome: "FAIL", comment: "not handed over safely" });
  assert.equal((await status(id)).current_step_id, "maker_rotate");
  await completeStep(id, "maker_rotate", { email: "a@x", persona: "ADMIN" }, { checklist: { generated: true, handed_over: true } });
  await completeStep(id, "checker_approve", { email: "b@x", persona: "SUPER_ADMIN" }, { checklist: { verified: true } });
  assert.equal((await status(id)).current_step_id, "old_key_retired");     // no new live key yet
  await rows("checkout", `INSERT INTO merchant_checkout_keys (mkey, merchant_code, scheme, livemode, created_at) VALUES ($1, $2, 'HMAC_SHA256', true, now() + interval '1 second')`,
    [`itest_${N}`, bankerCode]);
  await syncInstance(id);
  assert.equal((await status(id)).status, "COMPLETED");
});

test("TSP go-live follows its Maker-Checker request: pending waits, rejected loops, approved passes", opts, async () => {
  const id = await start("tsp_onboarding", tspId);
  assert.equal((await status(id)).current_step_id, "go_live");
  await mc("tsp.go_live", tspId, "PENDING");
  await syncInstance(id);
  assert.equal((await status(id)).current_step_id, "go_live");
  await rows("provider", `UPDATE maker_checker_requests SET status = 'REJECTED', decided_at = now() WHERE request_id = $1::uuid`, [requests.at(-1)]);
  await syncInstance(id);
  await syncInstance(id);   // the same rejection fails it once only
  const d = await instanceDetail(id, { persona: "ADMIN" });
  assert.equal(d.instance.status, "IN_PROGRESS");
  assert.equal(d.events.filter((e) => e.event === "FAILED").length, 1);
  await mc("tsp.go_live", tspId, "APPROVED");
  await syncInstance(id);
  assert.equal((await status(id)).status, "COMPLETED");
  // The workflow never moved the TSP: approving the request is what the Maker-Checker route does.
  assert.equal((await rows<{ stage: string }>("merchant", `SELECT stage FROM tsps WHERE id = $1::uuid`, [tspId]))[0].stage, "CONFIG");
});

test("reject closes the workflow only; escalate records and alerts; events are append-only", opts, async () => {
  const id = await start("banker_suspension", bankerId);
  await escalateStep(id, "trigger", { email: "r@x", persona: "RISK" }, "fraud complaints from three customers");
  assert.equal(await code(rejectInstance(id, { email: "f@x", persona: "FINANCE" }, "not needed after all")), "WRONG_ROLE");
  await rejectInstance(id, { email: "r@x", persona: "RISK" }, "complaints were withdrawn");
  assert.equal((await status(id)).status, "REJECTED");
  assert.equal((await rows<{ stage: string }>("merchant", `SELECT stage FROM merchants WHERE id = $1::uuid`, [bankerId]))[0].stage, "LIVE");
  const ev = await rows<{ event: string }>("merchant", `SELECT event FROM workflow_step_events WHERE instance_id = $1::uuid ORDER BY id`, [id]);
  assert.deepEqual(ev.map((e) => e.event), ["STARTED", "ESCALATED", "REJECTED"]);
  await assert.rejects(rows("merchant", `UPDATE workflow_step_events SET comment = 'x' WHERE instance_id = $1::uuid`, [id]), /append-only/);
  const list = await listInstances({ actor_id: bankerId, status: "REJECTED" });
  assert.ok(list.some((i) => i.id === id));
});

test("a template edit is a new version through Maker-Checker; a stale proposal is refused", opts, async () => {
  const steps: StepDef[] = [{ step_id: "a", name: "A", step_type: "MANUAL_REVIEW", assigned_role: "OPERATOR", checklist_items: [], timeout_hours: 4 }];
  await rows("merchant", `INSERT INTO workflow_templates (key, name, actor_type, steps, version, active, created_by) VALUES ($1, 'Itest', 'BANKER', $2::jsonb, 1, true, 'itest')`,
    [TKEY, JSON.stringify(steps)]);
  assert.equal(await code(proposeTemplateVersion(TKEY, { steps: [{ ...steps[0], on_pass: "nope" }] }, { id: "m", email: "m@x" })), "INVALID_TEMPLATE");
  const { request_id } = await proposeTemplateVersion(TKEY, { steps: [{ ...steps[0], timeout_hours: 8 }] }, { id: "m", email: "m@x" });
  requests.push(request_id);
  const id = await start(TKEY, bankerId);
  const payload = (await rows<{ payload: Record<string, unknown> }>("provider", `SELECT payload FROM maker_checker_requests WHERE request_id = $1::uuid`, [request_id]))[0].payload;
  const v = await applyTemplateVersion(payload, { id: "c", email: "c@x" });
  assert.equal(v.version, 2);
  assert.equal(await code(applyTemplateVersion(payload, { id: "c", email: "c@x" })), "TEMPLATE_CHANGED");
  const t = (await listTemplates(true)).filter((x) => x.key === TKEY);
  assert.deepEqual(t.map((x) => [x.version, x.active]), [[2, true], [1, false]]);
  // The running instance keeps version 1.
  assert.equal((await rows<{ v: number }>("merchant", `SELECT template_version AS v FROM workflow_instances WHERE id = $1::uuid`, [id]))[0].v, 1);
  assert.ok(OpenInstanceError);
});
