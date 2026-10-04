// Workflow rules (lib/workflow): templates, transitions, roles, SLA, automatic decisions.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  autoDecision, canActOnStep, canReject, completableSteps, completeRefusal, evalSystemCheck, actorClosed, slaStatus, slaDueAt,
  stepStates, savedChecklist, templateProblems, transition, passTarget, type BankerFacts, type StepDef, type TemplateDef, type EventRow,
} from "@/lib/workflow";

const step = (o: Partial<StepDef> & { step_id: string }): StepDef => ({
  name: o.step_id, step_type: "MANUAL_REVIEW", assigned_role: "OPERATOR", checklist_items: [], timeout_hours: 24, ...o,
});
const tpl = (steps: StepDef[], o: Partial<TemplateDef> = {}): TemplateDef => ({ key: "t_one", name: "T", actor_type: "BANKER", steps, ...o });
const banker = (o: Partial<BankerFacts> = {}): BankerFacts => ({
  kind: "banker", stage: "APPLICATION", step_config: false, has_chain: false, active_mids: 0, webhook_url: false,
  live_activated: false, test_payments: 0, live_key_created_at: null, ...o,
});
const ctx = { initiated_at: "2026-10-01T00:00:00.000Z" };

test("a valid template has no problems", () => {
  assert.deepEqual(templateProblems(tpl([step({ step_id: "a" }), step({ step_id: "b", step_type: "SYSTEM_CHECK", system_check: "banker.stage>=LIVE" })])), []);
});

test("step ids must be unique and targets must exist", () => {
  assert.match(templateProblems(tpl([step({ step_id: "a" }), step({ step_id: "a" })])).join(), /used twice/);
  assert.match(templateProblems(tpl([step({ step_id: "a", on_pass: "zz" })])).join(), /on_pass zz is not a step/);
  assert.match(templateProblems(tpl([step({ step_id: "a", on_fail: "nope" })])).join(), /on_fail nope/);
});

test("a cycle along on_pass is refused", () => {
  const p = templateProblems(tpl([step({ step_id: "a", on_pass: "b" }), step({ step_id: "b", on_pass: "a" })]));
  assert.match(p.join(), /cycle/);
});

test("a failure leading back needs loop: true", () => {
  const steps = [step({ step_id: "maker" }), step({ step_id: "checker", on_fail: "maker" })];
  assert.match(templateProblems(tpl(steps)).join(), /loop: true/);
  steps[1].loop = true;
  assert.deepEqual(templateProblems(tpl(steps)), []);
});

test("system checks must be known and about the template's actor", () => {
  assert.match(templateProblems(tpl([step({ step_id: "a", step_type: "SYSTEM_CHECK", system_check: "banker.magic" })])).join(), /unknown system_check/);
  assert.match(templateProblems(tpl([step({ step_id: "a", step_type: "SYSTEM_CHECK", system_check: "tsp.stage>=LIVE" })])).join(), /about a tsp/);
  assert.match(templateProblems(tpl([step({ step_id: "a", step_type: "SYSTEM_CHECK" })])).join(), /needs a system_check/);
  assert.match(templateProblems(tpl([step({ step_id: "a", step_type: "MAKER_CHECKER" })])).join(), /mc_action/);
  assert.match(templateProblems(tpl([step({ step_id: "a", assigned_role: "PROVIDER" as never })])).join(), /assigned_role/);
});

test("unreachable steps and bad distinct_from are reported", () => {
  assert.match(templateProblems(tpl([step({ step_id: "a", on_pass: "COMPLETE" }), step({ step_id: "b" })])).join(), /b can never be reached/);
  assert.match(templateProblems(tpl([step({ step_id: "a", distinct_from: "b" }), step({ step_id: "b" })])).join(), /earlier step/);
});

test("transitions: next step, the end, and a failure", () => {
  const steps = [step({ step_id: "a" }), step({ step_id: "b", on_fail: "a", loop: true }), step({ step_id: "c" })];
  assert.deepEqual(transition(steps, "a", "PASS"), { next: "b", status: "IN_PROGRESS" });
  assert.deepEqual(transition(steps, "b", "FAIL"), { next: "a", status: "IN_PROGRESS" });
  assert.deepEqual(transition(steps, "c", "PASS"), { next: null, status: "COMPLETED" });
  assert.deepEqual(transition(steps, "a", "FAIL"), { next: null, status: "REJECTED" });
  assert.equal(passTarget(steps, "a"), "b");
});

test("only the step's role or a Super Admin completes a manual step; automatic steps nobody", () => {
  const s = step({ step_id: "a", assigned_role: "COMPLIANCE" });
  assert.equal(canActOnStep("COMPLIANCE", s), true);
  assert.equal(canActOnStep("SUPER_ADMIN", s), true);
  assert.equal(canActOnStep("ADMIN", s), false);
  assert.equal(canActOnStep("SUPER_ADMIN", step({ step_id: "x", step_type: "SYSTEM_CHECK" })), false);
  assert.deepEqual(completableSteps("COMPLIANCE", [s, step({ step_id: "b" })]), ["a"]);
  assert.equal(canReject("ADMIN", s), true);
  assert.equal(canReject("COMPLIANCE", s), true);
  assert.equal(canReject("SUPPORT", s), false);
});

test("completing needs every item ticked and, for a checker, a second person", () => {
  const s = step({ step_id: "checker", assigned_role: "SUPER_ADMIN", distinct_from: "maker", checklist_items: [{ key: "ok", label: "OK" }] });
  const base = { status: "IN_PROGRESS" as const, currentStepId: "checker", step: s, persona: "SUPER_ADMIN", actor: "a@x", completedBy: { maker: "b@x" } };
  assert.equal(completeRefusal({ ...base, ticked: {} })?.code, "CHECKLIST_INCOMPLETE");
  assert.equal(completeRefusal({ ...base, ticked: { ok: true } }), null);
  assert.equal(completeRefusal({ ...base, ticked: { ok: true }, completedBy: { maker: "a@x" } })?.code, "SAME_PERSON");
  assert.equal(completeRefusal({ ...base, ticked: { ok: true }, persona: "SUPPORT" })?.code, "WRONG_ROLE");
  assert.equal(completeRefusal({ ...base, ticked: { ok: true }, currentStepId: "maker" })?.code, "NOT_CURRENT_STEP");
  assert.equal(completeRefusal({ ...base, ticked: { ok: true }, status: "REJECTED" })?.code, "NOT_IN_PROGRESS");
});

test("SLA: on track, at risk past 75%, breached past the timeout", () => {
  const start = new Date("2026-10-01T00:00:00Z");
  const at = (h: number) => new Date(start.getTime() + h * 3_600_000);
  assert.equal(slaStatus(start, 10, at(7)), "ON_TRACK");
  assert.equal(slaStatus(start, 10, at(8)), "AT_RISK");
  assert.equal(slaStatus(start, 10, at(10.5)), "BREACHED");
  assert.equal(slaStatus(start, null, at(1000)), "ON_TRACK");
  assert.equal(slaDueAt(start, 2)?.toISOString(), "2026-10-01T02:00:00.000Z");
  assert.equal(slaDueAt(start, null), null);
});

test("system checks read the facts: stage order, suspended, key rotated after start", () => {
  assert.equal(evalSystemCheck("banker.stage>=SCREENING", banker({ stage: "BANK_VERIFY" }), ctx), true);
  assert.equal(evalSystemCheck("banker.stage>=SCREENING", banker({ stage: "DOCS_PENDING" }), ctx), false);
  assert.equal(evalSystemCheck("banker.stage>=LIVE", banker({ stage: "SUSPENDED" }), ctx), false);
  assert.equal(evalSystemCheck("banker.stage=SUSPENDED", banker({ stage: "SUSPENDED" }), ctx), true);
  assert.equal(evalSystemCheck("banker.key_rotated", banker({ live_key_created_at: "2026-09-30T00:00:00Z" }), ctx), false);
  assert.equal(evalSystemCheck("banker.key_rotated", banker({ live_key_created_at: "2026-10-02T00:00:00Z" }), ctx), true);
  assert.equal(evalSystemCheck("tsp.stage=LIVE", banker(), ctx), false);
  assert.equal(evalSystemCheck("tsp.stage=LIVE", { kind: "tsp", stage: "LIVE", confirmed_banks: 1 }, ctx), true);
  assert.equal(evalSystemCheck("mid.status=ACTIVE", { kind: "mid", status: "ACTIVE", request_raised: true, bank_confirmed: true }, ctx), true);
});

test("a closed actor ends its instance", () => {
  assert.match(actorClosed(banker({ stage: "REJECTED" }))!, /REJECTED/);
  assert.equal(actorClosed(banker({ stage: "LIVE" })), null);
  assert.ok(actorClosed({ kind: "mid", status: "REJECTED", request_raised: true, bank_confirmed: false }));
  assert.ok(actorClosed(null));
});

test("automatic decisions: Maker-Checker approved / rejected / waiting, system check, notification", () => {
  const mc = step({ step_id: "go", step_type: "MAKER_CHECKER", mc_action: "tsp.go_live", system_check: "tsp.stage=LIVE" });
  const req = (status: string) => ({ request_id: "r1", status, created_at: "", decided_at: null });
  assert.equal(autoDecision(mc, { checkPasses: false, mc: req("APPROVED") }).kind, "PASS");
  assert.equal(autoDecision(mc, { checkPasses: false, mc: req("REJECTED") }).kind, "FAIL");
  assert.deepEqual(autoDecision(mc, { checkPasses: false, mc: req("PENDING") }), { kind: "WAIT", evidence: "r1" });
  assert.equal(autoDecision(mc, { checkPasses: true, mc: null }).kind, "PASS");
  const manual = step({ step_id: "m", system_check: "banker.stage>=LIVE" });
  assert.equal(autoDecision(manual, { checkPasses: false, mc: null }).kind, "WAIT");
  assert.equal(autoDecision(manual, { checkPasses: true, mc: null }).kind, "PASS");
  assert.equal(autoDecision(step({ step_id: "n", step_type: "NOTIFICATION" }), { checkPasses: false, mc: null, notified: true }).kind, "PASS");
});

test("step states and saved ticks come from the event log", () => {
  const steps = [step({ step_id: "a" }), step({ step_id: "b", checklist_items: [{ key: "x", label: "X" }] }), step({ step_id: "c" })];
  const ev = (id: number, step_id: string, event: EventRow["event"], checklist: Record<string, boolean> | null = null): EventRow =>
    ({ id, step_id, event, actor: "s", method: "SYSTEM_AUTO", checklist, comment: null, evidence_ref: null, at: "" });
  const events = [ev(1, "a", "STARTED"), ev(2, "a", "COMPLETED"), ev(3, "b", "STARTED"), ev(4, "b", "CHECKED", { x: true })];
  assert.deepEqual(stepStates(steps, events, "b", "IN_PROGRESS"), { a: "DONE", b: "ACTIVE", c: "PENDING" });
  assert.deepEqual(savedChecklist("b", events), { x: true });
  assert.deepEqual(savedChecklist("b", [...events, ev(5, "b", "STARTED")]), {});
});
