// Workflows: pure rules (storage and sync in lib/workflow-store, merchant 0021).
//
// A workflow is a TRACKING and ORCHESTRATION layer over the state machines that already exist.
// It never moves a real state: a banker's stage is still moved by /api/merchants/{id}/advance,
// a TSP's on its page, a MID by Maker-Checker. An instance mirrors one actor's journey:
//   SYSTEM_CHECK     completes when the real state shows it done (`system_check`, evaluated
//                    here from facts the store reads).
//   MAKER_CHECKER    completes when the linked request (`mc_action` on the actor) is APPROVED,
//                    fails when it is REJECTED. A `system_check` on it also completes it (a TSP
//                    that is already LIVE needs no new request).
//   MANUAL_REVIEW /  completed by a person in `assigned_role` (or a Super Admin) once every
//   DOCUMENT_UPLOAD  checklist item is ticked. A `system_check` on one completes it as well.
//   NOTIFICATION     sends an ops alert and completes.
// Staff only; a workflow may name a TSP, never shown to a merchant.

export const ACTOR_TYPES = ["TSP", "BANKER", "MERCHANT", "MID", "BANKER_SUSPENSION"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const STEP_TYPES = ["DOCUMENT_UPLOAD", "MANUAL_REVIEW", "SYSTEM_CHECK", "MAKER_CHECKER", "NOTIFICATION"] as const;
export type StepType = (typeof STEP_TYPES)[number];

/** The staff personas that read workflows and may be assigned a step. */
export const WORKFLOW_ROLES = ["SUPER_ADMIN", "ADMIN", "OPERATOR", "COMPLIANCE", "RISK", "FINANCE", "SUPPORT"] as const;
export type WorkflowRole = (typeof WORKFLOW_ROLES)[number];

export const INSTANCE_STATUSES = ["IN_PROGRESS", "PAUSED", "COMPLETED", "REJECTED"] as const;
export type InstanceStatus = (typeof INSTANCE_STATUSES)[number];

export type StepEvent = "STARTED" | "CHECKED" | "COMPLETED" | "FAILED" | "ESCALATED" | "REJECTED" | "COMMENT";
export type EventMethod = "MANUAL" | "SYSTEM_AUTO" | "MAKER_CHECKER";

/** Where a step leads: another step, or the end of the instance. */
export const END_COMPLETE = "COMPLETE";
export const END_REJECT = "REJECT";

export interface ChecklistDef { key: string; label: string }

export interface StepDef {
  step_id: string;
  name: string;
  step_type: StepType;
  assigned_role: WorkflowRole;
  checklist_items: ChecklistDef[];
  timeout_hours: number | null;
  /** Default: the next step in the list, or COMPLETE after the last one. */
  on_pass?: string;
  /** Default: REJECT. */
  on_fail?: string;
  /** A check key from SYSTEM_CHECKS (or a stage comparison) the engine evaluates. */
  system_check?: string;
  /** The Maker-Checker action whose request on this actor this step follows. */
  mc_action?: string;
  /** Four eyes: whoever completed that step may not complete this one. */
  distinct_from?: string;
  /** This step's on_fail may lead back to an earlier step (or itself). */
  loop?: boolean;
}

export interface TemplateDef {
  key: string;
  name: string;
  description?: string | null;
  actor_type: ActorType;
  trigger_event?: string | null;
  steps: StepDef[];
}

// ── System checks ───────────────────────────────────────────────────────────────────────────

/** The stages a banker passes through, in order. SUSPENDED / REJECTED / TERMINATED are off it. */
export const BANKER_STAGE_ORDER = ["APPLICATION", "DOCS_PENDING", "SCREENING", "BANK_VERIFY", "MID_ISSUANCE", "CONFIG", "IN_REVIEW", "APPROVED", "LIVE"] as const;
export const TSP_STAGE_ORDER = ["APPLICATION", "KYB_PENDING", "SCREENING", "BANK_VERIFY", "CONFIG", "LIVE"] as const;

/** The actor kind whose facts a check reads. */
export type FactKind = "banker" | "tsp" | "mid" | "merchant";
export function factKind(t: ActorType): FactKind {
  return t === "TSP" ? "tsp" : t === "MID" ? "mid" : t === "MERCHANT" ? "merchant" : "banker";
}

export interface BankerFacts {
  kind: "banker";
  stage: string;
  step_config: boolean;
  has_chain: boolean;
  active_mids: number;
  webhook_url: boolean;
  live_activated: boolean;
  test_payments: number;
  /** When the banker's live Key was made, ISO; null when it has none. */
  live_key_created_at: string | null;
}
export interface TspFacts { kind: "tsp"; stage: string; confirmed_banks: number }
export interface MidFacts { kind: "mid"; status: string; request_raised: boolean; bank_confirmed: boolean }
export interface MerchantFacts {
  kind: "merchant";
  kyc_status: string;
  status: string;
  bankers: number;
  keys: number;
  callbacks: number;
  test_payments: number;
  live_bankers: number;
}
export type ActorFacts = BankerFacts | TspFacts | MidFacts | MerchantFacts;

/** What a check may know about the instance besides the actor. */
export interface CheckContext { initiated_at: string }

type Check = { kind: FactKind; label: string; test: (f: any, c: CheckContext) => boolean };

/** Every named check the engine knows. Stage comparisons are parsed (stageCheck). */
export const SYSTEM_CHECKS: Record<string, Check> = {
  "banker.step_config": { kind: "banker", label: "Configuration step done", test: (f: BankerFacts) => f.step_config },
  "banker.chain_set": { kind: "banker", label: "TSP and issuing bank recorded", test: (f: BankerFacts) => f.has_chain },
  "banker.active_mid": { kind: "banker", label: "At least one active MID", test: (f: BankerFacts) => f.active_mids > 0 },
  "banker.webhook_url": { kind: "banker", label: "Webhook URL set", test: (f: BankerFacts) => f.webhook_url },
  "banker.test_payment": { kind: "banker", label: "A test payment succeeded", test: (f: BankerFacts) => f.test_payments > 0 },
  "banker.live_activated": { kind: "banker", label: "Live mode activated", test: (f: BankerFacts) => f.live_activated },
  "banker.key_rotated": {
    kind: "banker", label: "A new live Key was made after the workflow started",
    test: (f: BankerFacts, c) => !!f.live_key_created_at && Date.parse(f.live_key_created_at) > Date.parse(c.initiated_at),
  },
  "tsp.bank_confirmed": { kind: "tsp", label: "A bank confirmed the TSP", test: (f: TspFacts) => f.confirmed_banks > 0 },
  "mid.recorded": { kind: "mid", label: "MID entered", test: (f: MidFacts) => !!f.status },
  "mid.bank_confirmed": { kind: "mid", label: "The issuing bank confirmed the TSP", test: (f: MidFacts) => f.bank_confirmed },
  "mid.request_raised": { kind: "mid", label: "Sent for approval", test: (f: MidFacts) => f.request_raised || f.status === "ACTIVE" },
  "mid.status=ACTIVE": { kind: "mid", label: "MID active", test: (f: MidFacts) => f.status === "ACTIVE" },
  "merchant.kyc_approved": { kind: "merchant", label: "KYC approved", test: (f: MerchantFacts) => f.kyc_status === "APPROVED" },
  "merchant.has_banker": { kind: "merchant", label: "At least one banker mapped", test: (f: MerchantFacts) => f.bankers > 0 },
  "merchant.key_generated": { kind: "merchant", label: "A banker has a Key + Salt", test: (f: MerchantFacts) => f.keys > 0 },
  "merchant.callback_set": { kind: "merchant", label: "A banker has a webhook URL", test: (f: MerchantFacts) => f.callbacks > 0 },
  "merchant.test_payment": { kind: "merchant", label: "A test payment or payout succeeded", test: (f: MerchantFacts) => f.test_payments > 0 },
  "merchant.live": { kind: "merchant", label: "A banker is live", test: (f: MerchantFacts) => f.live_bankers > 0 },
};

const STAGE_RE = /^(banker|tsp)\.stage(>=|=)([A-Z_]+)$/;

/** A stage comparison, e.g. `banker.stage>=SCREENING`, `tsp.stage=LIVE`; null when not one. */
export function stageCheck(key: string): Check | null {
  const m = STAGE_RE.exec(key);
  if (!m) return null;
  const [, kind, op, stage] = m;
  const order: readonly string[] = kind === "banker" ? BANKER_STAGE_ORDER : TSP_STAGE_ORDER;
  const offOrder = kind === "banker" ? ["SUSPENDED", "REJECTED", "TERMINATED"] : ["SUSPENDED", "REJECTED"];
  if (op === ">=" && !order.includes(stage)) return null;
  if (op === "=" && !order.includes(stage) && !offOrder.includes(stage)) return null;
  return {
    kind: kind as FactKind,
    label: op === "=" ? `Stage is ${stage}` : `Stage ${stage} or later`,
    test: (f: { stage: string }) => op === "="
      ? f.stage === stage
      : order.indexOf(f.stage) >= 0 && order.indexOf(f.stage) >= order.indexOf(stage),
  };
}

export function findCheck(key: string): Check | null {
  return SYSTEM_CHECKS[key] ?? stageCheck(key);
}

/** Whether the named check passes on these facts. An unknown check, or the wrong kind of facts, never passes. */
export function evalSystemCheck(key: string, facts: ActorFacts | null, ctx: CheckContext): boolean {
  const c = findCheck(key);
  if (!c || !facts || facts.kind !== c.kind) return false;
  try { return !!c.test(facts, ctx); } catch { return false; }
}

export function checkLabel(key: string): string {
  return findCheck(key)?.label ?? key;
}

/**
 * The actor has left the journey for good: a rejected or terminated banker, a rejected TSP, a
 * MID that was rejected or withdrawn. The instance is then closed as REJECTED by the system.
 */
export function actorClosed(f: ActorFacts | null): string | null {
  if (!f) return "the actor no longer exists";
  if (f.kind === "banker" && (f.stage === "REJECTED" || f.stage === "TERMINATED")) return `the banker is ${f.stage}`;
  if (f.kind === "tsp" && f.stage === "REJECTED") return "the TSP was rejected";
  if (f.kind === "mid" && f.status === "REJECTED") return "the MID was rejected or withdrawn";
  return null;
}

// ── Templates ───────────────────────────────────────────────────────────────────────────────

const STEP_ID_RE = /^[a-z][a-z0-9_]{0,39}$/;
export const TEMPLATE_KEY_RE = /^[a-z][a-z0-9_]{1,47}$/;

/** Where a step goes on pass: its own on_pass, else the next step, else COMPLETE. */
export function passTarget(steps: StepDef[], stepId: string): string {
  const i = steps.findIndex((s) => s.step_id === stepId);
  if (i < 0) return END_COMPLETE;
  return steps[i].on_pass || steps[i + 1]?.step_id || END_COMPLETE;
}

export function failTarget(steps: StepDef[], stepId: string): string {
  return steps.find((s) => s.step_id === stepId)?.on_fail || END_REJECT;
}

/** Every problem with a template; empty when it is valid. */
export function templateProblems(t: TemplateDef): string[] {
  const p: string[] = [];
  if (!TEMPLATE_KEY_RE.test(t.key ?? "")) p.push("key: 2–48 lower-case letters, digits or _, starting with a letter");
  if (!t.name?.trim()) p.push("name is required");
  if (!(ACTOR_TYPES as readonly string[]).includes(t.actor_type)) p.push(`actor_type must be one of ${ACTOR_TYPES.join(", ")}`);
  if (!Array.isArray(t.steps) || t.steps.length === 0) { p.push("a template needs at least one step"); return p; }
  if (t.steps.length > 40) p.push("at most 40 steps");
  const ids = new Set<string>();
  const kind = factKind(t.actor_type);
  t.steps.forEach((s, i) => {
    const at = `step ${i + 1}${s?.step_id ? ` (${s.step_id})` : ""}`;
    if (!s || typeof s !== "object") { p.push(`${at}: not an object`); return; }
    if (!STEP_ID_RE.test(s.step_id ?? "")) p.push(`${at}: step_id must be 1–40 lower-case letters, digits or _`);
    else if (ids.has(s.step_id)) p.push(`${at}: step_id is used twice`);
    else if (s.step_id === END_COMPLETE || s.step_id === END_REJECT) p.push(`${at}: step_id is reserved`);
    ids.add(s.step_id);
    if (!s.name?.trim()) p.push(`${at}: name is required`);
    if (!(STEP_TYPES as readonly string[]).includes(s.step_type)) p.push(`${at}: step_type must be one of ${STEP_TYPES.join(", ")}`);
    if (!(WORKFLOW_ROLES as readonly string[]).includes(s.assigned_role)) p.push(`${at}: assigned_role must be one of ${WORKFLOW_ROLES.join(", ")}`);
    if (!Array.isArray(s.checklist_items)) p.push(`${at}: checklist_items must be a list`);
    else {
      const keys = new Set<string>();
      for (const c of s.checklist_items) {
        if (!c || !/^[a-z][a-z0-9_]{0,39}$/.test(c.key ?? "") || !c.label?.trim()) { p.push(`${at}: each checklist item needs a key (lower-case) and a label`); break; }
        if (keys.has(c.key)) { p.push(`${at}: checklist key ${c.key} is used twice`); break; }
        keys.add(c.key);
      }
    }
    if (s.timeout_hours !== null && s.timeout_hours !== undefined
        && (typeof s.timeout_hours !== "number" || !Number.isFinite(s.timeout_hours) || s.timeout_hours <= 0 || s.timeout_hours > 24 * 90))
      p.push(`${at}: timeout_hours must be above 0 and at most 2160, or null`);
    if (s.system_check !== undefined && s.system_check !== null) {
      const c = findCheck(s.system_check);
      if (!c) p.push(`${at}: unknown system_check ${s.system_check}`);
      else if (c.kind !== kind) p.push(`${at}: system_check ${s.system_check} is about a ${c.kind}, not this template's actor`);
    }
    if (s.step_type === "SYSTEM_CHECK" && !s.system_check) p.push(`${at}: a SYSTEM_CHECK step needs a system_check`);
    if (s.step_type === "MAKER_CHECKER" && !/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*$/.test(s.mc_action ?? ""))
      p.push(`${at}: a MAKER_CHECKER step needs an mc_action (e.g. mid.issue)`);
    if (s.step_type !== "MAKER_CHECKER" && s.mc_action) p.push(`${at}: only a MAKER_CHECKER step has an mc_action`);
  });
  if (p.length) return p;

  const order = new Map(t.steps.map((s, i) => [s.step_id, i]));
  const target = (x: string | undefined) => x === undefined || x === "" || x === END_COMPLETE || x === END_REJECT || order.has(x);
  for (const s of t.steps) {
    if (!target(s.on_pass)) p.push(`${s.step_id}: on_pass ${s.on_pass} is not a step`);
    if (!target(s.on_fail)) p.push(`${s.step_id}: on_fail ${s.on_fail} is not a step`);
    if (s.on_pass === END_REJECT) p.push(`${s.step_id}: on_pass cannot be REJECT`);
    if (s.distinct_from !== undefined) {
      if (!order.has(s.distinct_from)) p.push(`${s.step_id}: distinct_from ${s.distinct_from} is not a step`);
      else if (order.get(s.distinct_from)! >= order.get(s.step_id)!) p.push(`${s.step_id}: distinct_from must be an earlier step`);
    }
    // A failure leading back (to an earlier step or itself) is a loop: it must say so.
    if (s.on_fail && order.has(s.on_fail) && order.get(s.on_fail)! <= order.get(s.step_id)! && !s.loop)
      p.push(`${s.step_id}: on_fail leads back to ${s.on_fail}; mark the step loop: true if that is meant`);
  }
  if (p.length) return p;

  // The pass path must reach the end: no cycle along on_pass.
  for (const s of t.steps) {
    const seen = new Set<string>();
    let cur: string = s.step_id;
    while (cur !== END_COMPLETE) {
      if (seen.has(cur)) { p.push(`on_pass from ${s.step_id} goes round in a cycle (${[...seen].join(" → ")})`); break; }
      seen.add(cur);
      cur = passTarget(t.steps, cur);
    }
    if (p.length) break;
  }
  // Every step can be reached from the first.
  const reach = new Set<string>();
  const stack = [t.steps[0].step_id];
  while (stack.length) {
    const id = stack.pop()!;
    if (reach.has(id) || !order.has(id)) continue;
    reach.add(id);
    stack.push(passTarget(t.steps, id), failTarget(t.steps, id));
  }
  for (const s of t.steps) if (!reach.has(s.step_id)) p.push(`${s.step_id} can never be reached`);
  return p;
}

/** Fill the defaults a template author may leave out. */
export function normaliseSteps(steps: StepDef[]): StepDef[] {
  return steps.map((s) => ({
    ...s,
    name: (s.name ?? "").trim(),
    checklist_items: (s.checklist_items ?? []).map((c) => ({ key: c.key, label: (c.label ?? "").trim() })),
    timeout_hours: s.timeout_hours ?? null,
  }));
}

// ── Roles ───────────────────────────────────────────────────────────────────────────────────

export const isWorkflowRole = (p: string): p is WorkflowRole => (WORKFLOW_ROLES as readonly string[]).includes(p);

/** Whether this persona may complete (or fail) the step. A Super Admin may act for any role. */
export function canActOnStep(persona: string, step: Pick<StepDef, "assigned_role" | "step_type">): boolean {
  if (step.step_type !== "MANUAL_REVIEW" && step.step_type !== "DOCUMENT_UPLOAD") return false;
  return persona === "SUPER_ADMIN" || persona === step.assigned_role;
}

/** Who may reject an instance at this step: Super Admin, Admin, or the step's role. */
export function canReject(persona: string, step: Pick<StepDef, "assigned_role"> | null): boolean {
  return persona === "SUPER_ADMIN" || persona === "ADMIN" || (!!step && persona === step.assigned_role);
}

/** The steps this persona would complete by hand, of the given template. */
export function completableSteps(persona: string, steps: StepDef[]): string[] {
  return steps.filter((s) => canActOnStep(persona, s)).map((s) => s.step_id);
}

/** The first checklist item not ticked, or null when all are. */
export function missingChecklist(step: Pick<StepDef, "checklist_items">, ticked: Record<string, boolean> | null | undefined): ChecklistDef[] {
  return step.checklist_items.filter((c) => ticked?.[c.key] !== true);
}

export type CompleteRefusal = { code: string; message: string };

/** Why a person may not complete this step now, or null. */
export function completeRefusal(a: {
  status: InstanceStatus;
  currentStepId: string | null;
  step: StepDef | undefined;
  persona: string;
  actor: string;
  ticked: Record<string, boolean> | null | undefined;
  /** Who completed each earlier step most recently (for distinct_from). */
  completedBy: Record<string, string>;
}): CompleteRefusal | null {
  if (a.status !== "IN_PROGRESS") return { code: "NOT_IN_PROGRESS", message: `the workflow is ${a.status}` };
  if (!a.step) return { code: "NO_SUCH_STEP", message: "no such step in this workflow" };
  if (a.step.step_id !== a.currentStepId) return { code: "NOT_CURRENT_STEP", message: "that step is not the current one" };
  if (a.step.step_type === "SYSTEM_CHECK" || a.step.step_type === "MAKER_CHECKER" || a.step.step_type === "NOTIFICATION")
    return { code: "AUTOMATIC_STEP", message: `a ${a.step.step_type} step completes by itself when the real state shows it done` };
  if (!canActOnStep(a.persona, a.step)) return { code: "WRONG_ROLE", message: `this step is for ${a.step.assigned_role}` };
  const missing = missingChecklist(a.step, a.ticked);
  if (missing.length) return { code: "CHECKLIST_INCOMPLETE", message: `not ticked: ${missing.map((m) => m.label).join("; ")}` };
  if (a.step.distinct_from && a.completedBy[a.step.distinct_from] && a.completedBy[a.step.distinct_from] === a.actor)
    return { code: "SAME_PERSON", message: "you completed the maker step; a second person must complete this one" };
  return null;
}

// ── Transitions ─────────────────────────────────────────────────────────────────────────────

export interface Transition {
  /** The step the instance moves to; null when it ends. */
  next: string | null;
  status: InstanceStatus;
}

/** Where an instance goes when `stepId` passes or fails. */
export function transition(steps: StepDef[], stepId: string, outcome: "PASS" | "FAIL"): Transition {
  const to = outcome === "PASS" ? passTarget(steps, stepId) : failTarget(steps, stepId);
  if (to === END_COMPLETE) return { next: null, status: "COMPLETED" };
  if (to === END_REJECT) return { next: null, status: "REJECTED" };
  return { next: to, status: "IN_PROGRESS" };
}

/** What the engine does with the current step, from what it read. */
export type AutoDecision =
  | { kind: "WAIT"; evidence?: string }
  | { kind: "PASS"; method: EventMethod; evidence?: string; note: string }
  | { kind: "FAIL"; method: EventMethod; evidence?: string; note: string };

export interface McState { request_id: string; status: string; decided_at: string | null; created_at: string }

/**
 * The automatic decision on the current step: a system check that holds passes it; a
 * Maker-Checker request APPROVED passes it, REJECTED fails it; a notification passes once sent.
 * A person's step waits unless its own system check already holds.
 */
export function autoDecision(step: StepDef, a: { checkPasses: boolean; mc: McState | null; notified?: boolean }): AutoDecision {
  if (step.step_type === "MAKER_CHECKER") {
    if (a.mc?.status === "APPROVED") return { kind: "PASS", method: "MAKER_CHECKER", evidence: a.mc.request_id, note: "approved by a second person" };
    if (step.system_check && a.checkPasses) return { kind: "PASS", method: "SYSTEM_AUTO", note: checkLabel(step.system_check) };
    if (a.mc?.status === "REJECTED") return { kind: "FAIL", method: "MAKER_CHECKER", evidence: a.mc.request_id, note: "rejected by the checker" };
    return { kind: "WAIT", evidence: a.mc?.status === "PENDING" ? a.mc.request_id : undefined };
  }
  if (step.step_type === "NOTIFICATION")
    return a.notified ? { kind: "PASS", method: "SYSTEM_AUTO", note: "operations told" } : { kind: "WAIT" };
  if (step.system_check && a.checkPasses) return { kind: "PASS", method: "SYSTEM_AUTO", note: checkLabel(step.system_check) };
  return { kind: "WAIT" };
}

// ── SLA ─────────────────────────────────────────────────────────────────────────────────────

export type SlaStatus = "ON_TRACK" | "AT_RISK" | "BREACHED";

/** ON_TRACK, AT_RISK past 75% of the step's timeout, BREACHED past it. No timeout: ON_TRACK. */
export function slaStatus(stepStartedAt: string | Date, timeoutHours: number | null | undefined, now: Date = new Date()): SlaStatus {
  if (!timeoutHours || timeoutHours <= 0) return "ON_TRACK";
  const started = typeof stepStartedAt === "string" ? Date.parse(stepStartedAt) : stepStartedAt.getTime();
  const elapsed = now.getTime() - started;
  const limit = timeoutHours * 3_600_000;
  if (elapsed > limit) return "BREACHED";
  if (elapsed > limit * 0.75) return "AT_RISK";
  return "ON_TRACK";
}

export function slaDueAt(stepStartedAt: Date, timeoutHours: number | null | undefined): Date | null {
  return timeoutHours && timeoutHours > 0 ? new Date(stepStartedAt.getTime() + timeoutHours * 3_600_000) : null;
}

// ── Step states, from the event log ─────────────────────────────────────────────────────────

export interface EventRow { id: number | string; step_id: string; event: StepEvent; actor: string; method: EventMethod | null; checklist: Record<string, boolean> | null; comment: string | null; evidence_ref: string | null; at: string }

export type StepState = "PENDING" | "ACTIVE" | "DONE" | "FAILED" | "SKIPPED";

/** Each step's state: its latest STARTED / COMPLETED / FAILED event decides; current wins. */
export function stepStates(steps: StepDef[], events: EventRow[], currentStepId: string | null, status: InstanceStatus): Record<string, StepState> {
  const out: Record<string, StepState> = {};
  for (const s of steps) {
    const last = [...events].reverse().find((e) => e.step_id === s.step_id && (e.event === "STARTED" || e.event === "COMPLETED" || e.event === "FAILED"));
    out[s.step_id] = !last ? "PENDING" : last.event === "COMPLETED" ? "DONE" : last.event === "FAILED" ? "FAILED" : "ACTIVE";
  }
  if (currentStepId && status === "IN_PROGRESS") out[currentStepId] = "ACTIVE";
  return out;
}

/** The ticks saved for the step since it last started. */
export function savedChecklist(stepId: string, events: EventRow[]): Record<string, boolean> {
  let ticks: Record<string, boolean> = {};
  for (const e of events) {
    if (e.step_id !== stepId) continue;
    if (e.event === "STARTED") ticks = {};
    if ((e.event === "CHECKED" || e.event === "COMPLETED") && e.checklist) ticks = { ...e.checklist };
  }
  return ticks;
}

/** Who most recently completed each step by hand. */
export function completedByMap(events: EventRow[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (const e of events) if (e.event === "COMPLETED" && e.method === "MANUAL") m[e.step_id] = e.actor;
  return m;
}

/** When the step last started, or null. */
export function lastStarted(stepId: string, events: EventRow[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].step_id === stepId && events[i].event === "STARTED") return events[i].at;
  return null;
}

/** The step's latest FAILED event's time (a Maker-Checker step looks only at requests raised after it). */
export function lastFailed(stepId: string, events: EventRow[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].step_id === stepId && events[i].event === "FAILED") return events[i].at;
  return null;
}
