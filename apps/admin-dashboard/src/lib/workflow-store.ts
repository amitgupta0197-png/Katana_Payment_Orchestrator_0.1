// Workflows: storage, sync and actions (merchant 0021). Rules are pure, in lib/workflow.ts.
//
// The engine only READS the real states (merchants, tsps, issued_mids, providers, Maker-Checker
// requests, keys, test payments) and records what it saw in its own tables. Nothing here moves a
// banker, a TSP, a MID or a request: completing or rejecting a workflow step changes the workflow
// only. With the workflow tables empty, nothing anywhere behaves differently.
//
// Staff only. Instances may name a TSP: never return them to a merchant or banker login.

import type { PoolClient } from "pg";
import { db, rows } from "@/lib/pg";
import { raiseAlert, resolveAlert, openAlerts } from "@/lib/ops-alert";
import { wormAppend } from "@/lib/worm";
import { requestApproval, type Maker } from "@/lib/maker-checker";
import type { Persona } from "@/lib/auth";
import {
  actorClosed, autoDecision, checkLabel, completeRefusal, completedByMap, canActOnStep, canReject, evalSystemCheck, factKind,
  lastFailed, normaliseSteps, savedChecklist, slaDueAt, slaStatus, stepStates, templateProblems, transition, isWorkflowRole,
  type ActorFacts, type ActorType, type EventMethod, type EventRow, type InstanceStatus, type McState, type SlaStatus, type StepDef,
  type StepEvent, type StepState, type TemplateDef,
} from "@/lib/workflow";

/** Who reads workflows (and may comment and escalate). */
export const WORKFLOW_READ: Persona[] = ["SUPER_ADMIN", "ADMIN", "OPERATOR", "COMPLIANCE", "RISK", "FINANCE", "SUPPORT"];
/** Who may start a workflow by hand (key rotation, suspension, a merchant's onboarding). */
export const WORKFLOW_START: Persona[] = ["SUPER_ADMIN", "ADMIN", "OPERATOR", "COMPLIANCE", "RISK"];
/** Who may propose a template change and run a full sync. */
export const WORKFLOW_ADMIN: Persona[] = ["SUPER_ADMIN", "ADMIN"];

/** The Maker-Checker action that applies a proposed template version. Register in MC_ACTIONS. */
export const WORKFLOW_TEMPLATE_UPDATE = "workflow.template_update";

export class WorkflowError extends Error {
  constructor(public status: number, public code: string, message: string, public extra: Record<string, unknown> = {}) { super(message); }
}

export interface Actor { email: string; persona: string; id?: string }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Templates ───────────────────────────────────────────────────────────────────────────────

export interface TemplateRow extends TemplateDef {
  id: string;
  version: number;
  active: boolean;
  created_by: string | null;
  created_at: string;
}

const T_COLS = `id::text, key, name, description, actor_type, trigger_event, steps, version, active, created_by, created_at`;

export async function listTemplates(all = false): Promise<TemplateRow[]> {
  return rows<TemplateRow>("merchant", `
    SELECT ${T_COLS} FROM workflow_templates ${all ? "" : "WHERE active"} ORDER BY key, version DESC`);
}

export async function activeTemplate(key: string): Promise<TemplateRow | null> {
  return (await rows<TemplateRow>("merchant", `SELECT ${T_COLS} FROM workflow_templates WHERE key = $1 AND active`, [key]))[0] ?? null;
}

async function templateById(id: string): Promise<TemplateRow | null> {
  return (await rows<TemplateRow>("merchant", `SELECT ${T_COLS} FROM workflow_templates WHERE id = $1::uuid`, [id]))[0] ?? null;
}

export interface TemplateDraft {
  name?: string;
  description?: string | null;
  trigger_event?: string | null;
  steps: StepDef[];
}

/**
 * Propose a new version of a template. Validated now, applied by a second person through
 * Maker-Checker (`workflow.template_update` → applyTemplateVersion). Instances keep their version.
 */
export async function proposeTemplateVersion(key: string, draft: TemplateDraft, maker: Maker, notes?: string): Promise<{ request_id: string }> {
  const cur = await activeTemplate(key);
  if (!cur) throw new WorkflowError(404, "NOT_FOUND", "no such template");
  const next: TemplateDef = {
    key, actor_type: cur.actor_type, name: (draft.name ?? cur.name).trim(),
    description: draft.description === undefined ? cur.description : draft.description,
    trigger_event: draft.trigger_event === undefined ? cur.trigger_event : draft.trigger_event,
    steps: normaliseSteps(draft.steps ?? []),
  };
  const problems = templateProblems(next);
  if (problems.length) throw new WorkflowError(400, "INVALID_TEMPLATE", problems[0], { problems });
  if (JSON.stringify(next.steps) === JSON.stringify(normaliseSteps(cur.steps)) && next.name === cur.name && next.description === cur.description)
    throw new WorkflowError(409, "NO_CHANGE", "the proposed version is the same as the active one");
  const request_id = await requestApproval({
    resourceType: "workflow_template", resourceId: key, action: WORKFLOW_TEMPLATE_UPDATE, maker, notes,
    payload: { template_key: key, base_version: cur.version, name: next.name, description: next.description ?? null,
      trigger_event: next.trigger_event ?? null, steps: next.steps },
    summary: `Workflow template "${cur.name}": version ${cur.version + 1} (${next.steps.length} steps)`,
  });
  return { request_id };
}

/**
 * What approving `workflow.template_update` does: the proposed steps become the next version
 * and the active one. Refuses when another version was made since the proposal (its base).
 * For lib/maker-checker-actions: `{ apply: (r, c) => applyTemplateVersion(r.payload, c) }`.
 */
export async function applyTemplateVersion(payload: Record<string, any>, checker?: Maker): Promise<{ id: string; key: string; version: number }> {
  const key = String(payload?.template_key ?? "");
  return tx(async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('workflow_template:' || $1))`, [key]);
    const cur = (await c.query(`SELECT ${T_COLS} FROM workflow_templates WHERE key = $1 AND active`, [key])).rows[0] as TemplateRow | undefined;
    if (!cur) throw new WorkflowError(404, "NOT_FOUND", "no such template");
    if (Number(payload.base_version) !== cur.version)
      throw new WorkflowError(409, "TEMPLATE_CHANGED", `the template is at version ${cur.version} now; propose the change again`);
    const def: TemplateDef = { key, actor_type: cur.actor_type, name: String(payload.name ?? cur.name), description: payload.description ?? null,
      trigger_event: payload.trigger_event ?? cur.trigger_event, steps: normaliseSteps(payload.steps ?? []) };
    const problems = templateProblems(def);
    if (problems.length) throw new WorkflowError(400, "INVALID_TEMPLATE", problems[0], { problems });
    const max = (await c.query(`SELECT MAX(version)::int AS v FROM workflow_templates WHERE key = $1`, [key])).rows[0].v as number;
    await c.query(`UPDATE workflow_templates SET active = false WHERE key = $1 AND active`, [key]);
    const r = (await c.query(`
      INSERT INTO workflow_templates (key, name, description, actor_type, trigger_event, steps, version, active, created_by)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, true, $8) RETURNING id::text, version`,
      [key, def.name, def.description, def.actor_type, def.trigger_event, JSON.stringify(def.steps), max + 1, checker?.email ?? null])).rows[0];
    await wormAppend({ actorId: checker?.id ?? null, actorEmail: checker?.email ?? null, action: "workflow.template.version",
      resourceType: "workflow_template", resourceId: key, before: { version: cur.version }, after: { version: r.version, steps: def.steps.length } }).catch(() => {});
    return { id: r.id as string, key, version: r.version as number };
  });
}

// ── Actors: what the engine reads ───────────────────────────────────────────────────────────

const none = <T>(fallback: T) => () => fallback;

/** The facts the system checks read, from the real tables. Null when the actor is gone. */
export async function loadFacts(actorType: ActorType, actorId: string): Promise<ActorFacts | null> {
  if (!UUID_RE.test(actorId)) return null;
  const kind = factKind(actorType);
  if (kind === "banker") {
    const m = (await rows<{ merchant_code: string; stage: string; step_config: boolean; chain: boolean; webhook_url: string | null }>("merchant", `
      SELECT merchant_code, stage, COALESCE(step_config, false) AS step_config,
             (parent_tsp_id IS NOT NULL AND issuing_bank_id IS NOT NULL) AS chain, webhook_url
        FROM merchants WHERE id = $1::uuid`, [actorId]))[0];
    if (!m) return null;
    const code = m.merchant_code;
    const [mids, act, payins, checkouts, key] = await Promise.all([
      rows<{ n: number }>("merchant", `SELECT COUNT(*)::int AS n FROM issued_mids WHERE merchant_id = $1::uuid AND status = 'ACTIVE'`, [actorId]).catch(none([])),
      rows<{ status: string }>("merchant", `SELECT status FROM merchant_live_activation WHERE merchant_code = $1`, [code]).catch(none([])),
      rows<{ n: number }>("vendorGateway", `SELECT COUNT(*)::int AS n FROM vendor_payin_orders WHERE merchant_id = $1 AND livemode = false AND status IN ('SUCCESS','SUCCEEDED')`, [code]).catch(none([])),
      rows<{ n: number }>("checkout", `SELECT COUNT(*)::int AS n FROM checkout_orders WHERE merchant_id = $1 AND livemode = false AND status = 'SUCCESS'`, [code]).catch(none([])),
      rows<{ at: string }>("checkout", `SELECT created_at AS at FROM merchant_checkout_keys WHERE merchant_code = $1 AND livemode = true`, [code]).catch(none([])),
    ]);
    return {
      kind: "banker", stage: m.stage, step_config: m.step_config, has_chain: m.chain, active_mids: mids[0]?.n ?? 0,
      webhook_url: !!m.webhook_url?.trim(), live_activated: act[0]?.status === "ACTIVATED",
      test_payments: (payins[0]?.n ?? 0) + (checkouts[0]?.n ?? 0),
      live_key_created_at: key[0]?.at ? new Date(key[0].at).toISOString() : null,
    };
  }
  if (kind === "tsp") {
    const t = (await rows<{ stage: string; banks: number }>("merchant", `
      SELECT t.stage, (SELECT COUNT(*)::int FROM tsp_banks b WHERE b.tsp_id = t.id AND b.status = 'CONFIRMED') AS banks
        FROM tsps t WHERE t.id = $1::uuid`, [actorId]))[0];
    return t ? { kind: "tsp", stage: t.stage, confirmed_banks: t.banks } : null;
  }
  if (kind === "mid") {
    const i = (await rows<{ status: string; request_id: string | null; link: string | null }>("merchant", `
      SELECT i.status, i.request_id::text,
             (SELECT b.status FROM tsp_banks b WHERE b.tsp_id = i.tsp_id AND b.bank_id = i.bank_id) AS link
        FROM issued_mids i WHERE i.id = $1::uuid`, [actorId]))[0];
    return i ? { kind: "mid", status: i.status, request_raised: !!i.request_id, bank_confirmed: i.link === "CONFIRMED" } : null;
  }
  // A merchant (`providers` row) and the bankers mapped to it.
  const p = (await rows<{ kyc_status: string; status: string }>("provider", `SELECT kyc_status, status FROM providers WHERE id = $1::uuid`, [actorId]))[0];
  if (!p) return null;
  const maps = await rows<{ merchant_id: string }>("provider", `
    SELECT merchant_id::text FROM provider_merchant_mappings WHERE provider_id = $1::uuid AND status = 'ACTIVE'`, [actorId]);
  const bankers = maps.length ? await rows<{ merchant_code: string; stage: string; webhook_url: string | null }>("merchant", `
    SELECT merchant_code, stage, webhook_url FROM merchants WHERE id = ANY($1::uuid[])`, [maps.map((m) => m.merchant_id)]) : [];
  const codes = bankers.map((b) => b.merchant_code);
  const [keys, payins, payouts, activated] = codes.length ? await Promise.all([
    rows<{ n: number }>("checkout", `SELECT COUNT(DISTINCT merchant_code)::int AS n FROM merchant_checkout_keys WHERE merchant_code = ANY($1::text[])`, [codes]).catch(none([])),
    rows<{ n: number }>("vendorGateway", `SELECT COUNT(*)::int AS n FROM vendor_payin_orders WHERE merchant_id = ANY($1::text[]) AND livemode = false AND status IN ('SUCCESS','SUCCEEDED')`, [codes]).catch(none([])),
    rows<{ n: number }>("fifo", `SELECT COUNT(*)::int AS n FROM fifo_orders WHERE merchant_id = ANY($1::text[]) AND direction = 'PAYOUT' AND livemode = false AND status IN ('COMPLETED','SETTLED')`, [codes]).catch(none([])),
    rows<{ merchant_code: string }>("merchant", `SELECT merchant_code FROM merchant_live_activation WHERE merchant_code = ANY($1::text[]) AND status = 'ACTIVATED'`, [codes]).catch(none([])),
  ]) : [[], [], [], []];
  const activatedSet = new Set(activated.map((a) => a.merchant_code));
  return {
    kind: "merchant", kyc_status: p.kyc_status, status: p.status, bankers: bankers.length,
    keys: keys[0]?.n ?? 0, callbacks: bankers.filter((b) => !!b.webhook_url?.trim()).length,
    test_payments: (payins[0]?.n ?? 0) + (payouts[0]?.n ?? 0),
    live_bankers: bankers.filter((b) => b.stage === "LIVE" && activatedSet.has(b.merchant_code)).length,
  };
}

/** The actor's name and staff page. Null when it does not exist. */
export async function actorInfo(actorType: ActorType, actorId: string): Promise<{ label: string; link: string } | null> {
  if (!UUID_RE.test(actorId)) return null;
  const kind = factKind(actorType);
  if (kind === "banker") {
    const m = (await rows<{ code: string; name: string }>("merchant", `
      SELECT merchant_code AS code, COALESCE(NULLIF(brand_name, ''), legal_name) AS name FROM merchants WHERE id = $1::uuid`, [actorId]))[0];
    return m ? { label: `${m.name} (${m.code})`, link: `/bankers/${actorId}` } : null;
  }
  if (kind === "tsp") {
    const t = (await rows<{ code: string; name: string }>("merchant", `SELECT code, name FROM tsps WHERE id = $1::uuid`, [actorId]))[0];
    return t ? { label: `${t.name} (${t.code})`, link: `/tsps/${actorId}` } : null;
  }
  if (kind === "mid") {
    const i = (await rows<{ flow: string; v: string; code: string; mid: string; tsp: string }>("merchant", `
      SELECT i.flow, i.mid_value AS v, m.merchant_code AS code, m.id::text AS mid, t.code AS tsp
        FROM issued_mids i JOIN merchants m ON m.id = i.merchant_id JOIN tsps t ON t.id = i.tsp_id WHERE i.id = $1::uuid`, [actorId]))[0];
    return i ? { label: `${i.flow} MID …${i.v.slice(-4)} · ${i.code} (TSP ${i.tsp})`, link: `/bankers/${i.mid}` } : null;
  }
  const p = (await rows<{ code: string; name: string }>("provider", `SELECT code, legal_name AS name FROM providers WHERE id = $1::uuid`, [actorId]))[0];
  return p ? { label: `${p.name} (${p.code})`, link: `/merchants/${actorId}` } : null;
}

/** Actors of a type a person may start a workflow for (the start dialog). */
export async function listActors(actorType: ActorType, q = ""): Promise<{ id: string; label: string }[]> {
  const like = `%${q.trim()}%`;
  const kind = factKind(actorType);
  if (kind === "banker")
    return rows("merchant", `
      SELECT id::text, COALESCE(NULLIF(brand_name, ''), legal_name) || ' (' || merchant_code || ')' AS label FROM merchants
       WHERE ($1 = '%%' OR merchant_code ILIKE $1 OR legal_name ILIKE $1 OR brand_name ILIKE $1) ORDER BY created_at DESC LIMIT 50`, [like]);
  if (kind === "tsp")
    return rows("merchant", `SELECT id::text, name || ' (' || code || ')' AS label FROM tsps WHERE ($1 = '%%' OR code ILIKE $1 OR name ILIKE $1) ORDER BY code LIMIT 50`, [like]);
  if (kind === "mid")
    return rows("merchant", `
      SELECT i.id::text, i.flow || ' MID …' || right(i.mid_value, 4) || ' · ' || m.merchant_code || ' (' || i.status || ')' AS label
        FROM issued_mids i JOIN merchants m ON m.id = i.merchant_id
       WHERE ($1 = '%%' OR m.merchant_code ILIKE $1) ORDER BY i.created_at DESC LIMIT 50`, [like]);
  return rows("provider", `SELECT id::text, legal_name || ' (' || code || ')' AS label FROM providers WHERE ($1 = '%%' OR code ILIKE $1 OR legal_name ILIKE $1) ORDER BY legal_name LIMIT 50`, [like]);
}

/** The latest request for this action on this actor, raised after `after` when given. */
async function latestMc(action: string, actorId: string, after: string | null): Promise<McState | null> {
  const r = await rows<McState>("provider", `
    SELECT request_id::text, status, decided_at, created_at FROM maker_checker_requests
     WHERE resource_id = $1 AND action = $2 AND ($3::timestamptz IS NULL OR created_at > $3::timestamptz)
     ORDER BY created_at DESC LIMIT 1`, [actorId, action, after]).catch(() => []);
  return r[0] ?? null;
}

// ── Instances ───────────────────────────────────────────────────────────────────────────────

export interface InstanceRow {
  id: string;
  template_id: string;
  template_key: string;
  template_version: number;
  actor_type: ActorType;
  actor_id: string;
  actor_label: string | null;
  actor_link: string | null;
  current_step_id: string | null;
  status: InstanceStatus;
  initiated_by: string;
  initiated_at: string;
  step_started_at: string;
  completed_at: string | null;
  sla_due_at: string | null;
}

const I_COLS = `id::text, template_id::text, template_key, template_version, actor_type, actor_id, actor_label, actor_link, current_step_id,
  status, initiated_by, initiated_at, step_started_at, completed_at, sla_due_at`;

async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db("merchant").connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally { c.release(); }
}

async function addEvent(c: PoolClient, e: { instance_id: string; step_id: string; event: StepEvent; actor: string; method?: EventMethod | null;
  checklist?: Record<string, boolean> | null; comment?: string | null; evidence_ref?: string | null }): Promise<void> {
  await c.query(`
    INSERT INTO workflow_step_events (instance_id, step_id, event, actor, method, checklist, comment, evidence_ref)
    VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
    [e.instance_id, e.step_id, e.event, e.actor, e.method ?? null, e.checklist ? JSON.stringify(e.checklist) : null, e.comment ?? null, e.evidence_ref ?? null]);
}

async function eventsOf(instanceId: string, c?: PoolClient): Promise<EventRow[]> {
  const sql = `SELECT id, step_id, event, actor, method, checklist, comment, evidence_ref, at FROM workflow_step_events WHERE instance_id = $1::uuid ORDER BY id`;
  const r = c ? (await c.query(sql, [instanceId])).rows : await rows<EventRow>("merchant", sql, [instanceId]);
  return r.map((e: any) => ({ ...e, id: Number(e.id), at: new Date(e.at).toISOString() }));
}

/**
 * Move the instance on from `stepId` after it passed or failed: the next step is STARTED and its
 * SLA clock set, or the instance ends.
 */
async function moveOn(c: PoolClient, inst: InstanceRow, steps: StepDef[], stepId: string, outcome: "PASS" | "FAIL", actor: string): Promise<void> {
  const t = transition(steps, stepId, outcome);
  const now = new Date((await c.query(`SELECT clock_timestamp() AS t`)).rows[0].t);
  if (t.next) {
    const step = steps.find((s) => s.step_id === t.next)!;
    await addEvent(c, { instance_id: inst.id, step_id: t.next, event: "STARTED", actor, method: "SYSTEM_AUTO" });
    await c.query(`
      UPDATE workflow_instances SET current_step_id = $2, step_started_at = $3, sla_due_at = $4, updated_at = now() WHERE id = $1::uuid`,
      [inst.id, t.next, now, slaDueAt(now, step.timeout_hours)]);
  } else {
    await c.query(`
      UPDATE workflow_instances SET status = $2, current_step_id = NULL, completed_at = $3, sla_due_at = NULL, updated_at = now() WHERE id = $1::uuid`,
      [inst.id, t.status, now]);
  }
}

export class OpenInstanceError extends WorkflowError {
  constructor(public instanceId: string) { super(409, "ALREADY_OPEN", "this actor already has an open instance of this workflow", { instance_id: instanceId }); }
}

/**
 * Start a template's active version for an actor. One open instance per actor and template:
 * a second start is refused with the open one's id (OpenInstanceError). Syncs at once, so the
 * steps the real state already shows done are completed straight away.
 */
export async function startInstance(templateKey: string, actorId: string, by: string, opts: { sync?: boolean } = {}): Promise<{ id: string }> {
  const t = await activeTemplate(templateKey);
  if (!t) throw new WorkflowError(404, "NOT_FOUND", "no such template");
  const info = await actorInfo(t.actor_type, actorId);
  if (!info) throw new WorkflowError(404, "ACTOR_NOT_FOUND", `no such ${t.actor_type.toLowerCase().replace("_", " ")}`);
  const first = t.steps[0];
  const id = await tx(async (c) => {
    const now = new Date((await c.query(`SELECT clock_timestamp() AS t`)).rows[0].t);
    const r = await c.query(`
      INSERT INTO workflow_instances (template_id, template_key, template_version, actor_type, actor_id, actor_label, actor_link,
                                      current_step_id, initiated_by, initiated_at, step_started_at, sla_due_at)
      VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11)
      ON CONFLICT (template_key, actor_type, actor_id) WHERE status IN ('IN_PROGRESS','PAUSED') DO NOTHING
      RETURNING id::text`,
      [t.id, t.key, t.version, t.actor_type, actorId, info.label, info.link, first.step_id, by, now, slaDueAt(now, first.timeout_hours)]);
    if (!r.rows.length) return null;
    await addEvent(c, { instance_id: r.rows[0].id, step_id: first.step_id, event: "STARTED", actor: by, method: by === "system" ? "SYSTEM_AUTO" : "MANUAL" });
    return r.rows[0].id as string;
  });
  if (!id) {
    const open = (await rows<{ id: string }>("merchant", `
      SELECT id::text FROM workflow_instances WHERE template_key = $1 AND actor_type = $2 AND actor_id = $3 AND status IN ('IN_PROGRESS','PAUSED')`,
      [t.key, t.actor_type, actorId]))[0];
    throw new OpenInstanceError(open?.id ?? "");
  }
  if (opts.sync !== false) await syncInstance(id);
  return { id };
}

async function instanceWithTemplate(id: string, c?: PoolClient): Promise<{ inst: InstanceRow; tpl: TemplateRow } | null> {
  if (!UUID_RE.test(id)) return null;
  const sql = `SELECT ${I_COLS} FROM workflow_instances WHERE id = $1::uuid`;
  const inst = (c ? (await c.query(sql, [id])).rows[0] : (await rows<InstanceRow>("merchant", sql, [id]))[0]) as InstanceRow | undefined;
  if (!inst) return null;
  const tpl = await templateById(inst.template_id);
  return tpl ? { inst, tpl } : null;
}

/** Send a NOTIFICATION step: one ops message, not a standing condition (closed again at once, quietly). */
async function notify(inst: InstanceRow, tpl: TemplateRow, step: StepDef): Promise<void> {
  const key = `workflow:notify:${inst.id}:${step.step_id}`;
  await raiseAlert({ key, severity: "INFO", title: `${tpl.name}: ${step.name}`,
    body: `${inst.actor_label ?? inst.actor_id} reached "${step.name}".${inst.actor_link ? ` ${inst.actor_link}` : ""}` });
  await rows("audit", `UPDATE ops_alerts SET resolved_at = now() WHERE alert_key = $1 AND resolved_at IS NULL`, [key]).catch(() => {});
}

/**
 * Bring one instance up to date with the real state. Idempotent and safe to run concurrently:
 * a run that finds another one syncing the same instance does nothing. Returns how many steps
 * it moved on.
 */
export async function syncInstance(id: string): Promise<{ moved: number; status: InstanceStatus | null }> {
  const c = await db("merchant").connect();
  let moved = 0;
  try {
    await c.query("BEGIN");
    const lock = (await c.query(`SELECT pg_try_advisory_xact_lock(hashtext('workflow:' || $1)) AS ok`, [id])).rows[0].ok as boolean;
    if (!lock) { await c.query("ROLLBACK"); return { moved: 0, status: null }; }
    let status: InstanceStatus | null = null;
    for (let guard = 0; guard < 60; guard++) {
      const w = await instanceWithTemplate(id, c);
      if (!w) break;
      const { inst, tpl } = w;
      status = inst.status;
      if (inst.status !== "IN_PROGRESS" || !inst.current_step_id) break;
      const step = tpl.steps.find((s) => s.step_id === inst.current_step_id);
      if (!step) break;
      const facts = await loadFacts(inst.actor_type, inst.actor_id);
      const closed = actorClosed(facts);
      if (closed) {
        await addEvent(c, { instance_id: id, step_id: step.step_id, event: "REJECTED", actor: "system", method: "SYSTEM_AUTO", comment: `Closed: ${closed}.` });
        await c.query(`UPDATE workflow_instances SET status = 'REJECTED', completed_at = now(), sla_due_at = NULL, updated_at = now() WHERE id = $1::uuid`, [id]);
        moved++; status = "REJECTED";
        break;
      }
      const events = await eventsOf(id, c);
      const checkPasses = step.system_check ? evalSystemCheck(step.system_check, facts, { initiated_at: new Date(inst.initiated_at).toISOString() }) : false;
      const mc = step.step_type === "MAKER_CHECKER" && step.mc_action ? await latestMc(step.mc_action, inst.actor_id, lastFailed(step.step_id, events)) : null;
      let notified = false;
      if (step.step_type === "NOTIFICATION") { await notify(inst, tpl, step); notified = true; }
      const d = autoDecision(step, { checkPasses, mc, notified });
      if (d.kind === "WAIT") break;
      await addEvent(c, { instance_id: id, step_id: step.step_id, event: d.kind === "PASS" ? "COMPLETED" : "FAILED", actor: "system",
        method: d.method, comment: d.note, evidence_ref: d.evidence ?? null });
      await moveOn(c, inst, tpl.steps, step.step_id, d.kind, "system");
      moved++;
    }
    await c.query("COMMIT");
    const after = await rows<{ status: InstanceStatus }>("merchant", `SELECT status FROM workflow_instances WHERE id = $1::uuid`, [id]);
    return { moved, status: after[0]?.status ?? status };
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally { c.release(); }
}

/**
 * Start what should be running and sync every open instance:
 *   - Banker Onboarding for every banker not LIVE / REJECTED / TERMINATED / SUSPENDED with none
 *   - TSP Onboarding for every TSP not LIVE / REJECTED / SUSPENDED with none
 *   - MID Issuance for every PENDING_APPROVAL MID with none
 * "With none" means no instance ever, so a rejected instance is not started again by itself.
 */
export async function syncAll(): Promise<{ started: number; synced: number; moved: number; errors: string[] }> {
  const errors: string[] = [];
  let started = 0;
  const auto: { key: string; sql: string }[] = [
    { key: "banker_onboarding", sql: `SELECT id::text FROM merchants WHERE stage NOT IN ('LIVE','REJECTED','TERMINATED','SUSPENDED')` },
    { key: "tsp_onboarding", sql: `SELECT id::text FROM tsps WHERE stage NOT IN ('LIVE','REJECTED','SUSPENDED')` },
    { key: "mid_issuance", sql: `SELECT id::text FROM issued_mids WHERE status = 'PENDING_APPROVAL'` },
  ];
  for (const a of auto) {
    const t = await activeTemplate(a.key);
    if (!t) continue;
    const have = new Set((await rows<{ actor_id: string }>("merchant", `SELECT DISTINCT actor_id FROM workflow_instances WHERE template_key = $1`, [a.key])).map((r) => r.actor_id));
    const ids = (await rows<{ id: string }>("merchant", a.sql).catch(() => [])).map((r) => r.id).filter((id) => !have.has(id));
    for (const id of ids.slice(0, 500)) {
      try { await startInstance(a.key, id, "system", { sync: false }); started++; }
      catch (e) { if (!(e instanceof OpenInstanceError)) errors.push(`${a.key} ${id}: ${(e as Error).message}`); }
    }
  }
  const open = await rows<{ id: string }>("merchant", `SELECT id::text FROM workflow_instances WHERE status = 'IN_PROGRESS' ORDER BY initiated_at LIMIT 2000`);
  let moved = 0;
  for (const o of open) {
    try { moved += (await syncInstance(o.id)).moved; }
    catch (e) { errors.push(`${o.id}: ${(e as Error).message}`); }
  }
  return { started, synced: open.length, moved, errors };
}

// ── What a person does ──────────────────────────────────────────────────────────────────────

async function mustInstance(id: string) {
  const w = await instanceWithTemplate(id);
  if (!w) throw new WorkflowError(404, "NOT_FOUND", "no such workflow");
  return w;
}
const audit = (by: Actor, action: string, id: string, after: unknown, notes?: string) =>
  wormAppend({ actorId: by.id ?? null, actorEmail: by.email, action, resourceType: "workflow_instance", resourceId: id, after, notes }).catch(() => {});

/** Save the ticks on the current step without completing it. */
export async function saveChecklist(id: string, stepId: string, by: Actor, ticked: Record<string, boolean>): Promise<void> {
  const { inst, tpl } = await mustInstance(id);
  const step = tpl.steps.find((s) => s.step_id === stepId);
  if (inst.status !== "IN_PROGRESS" || inst.current_step_id !== stepId || !step) throw new WorkflowError(409, "NOT_CURRENT_STEP", "that step is not the current one");
  if (!canActOnStep(by.persona, step)) throw new WorkflowError(403, "WRONG_ROLE", `this step is for ${step.assigned_role}`);
  const clean = Object.fromEntries(step.checklist_items.map((c) => [c.key, ticked?.[c.key] === true]));
  await tx((c) => addEvent(c, { instance_id: id, step_id: stepId, event: "CHECKED", actor: by.email, method: "MANUAL", checklist: clean }));
}

/**
 * A person completes (`PASS`) or sends back (`FAIL`) the current manual step. Completing needs
 * the step's role (or a Super Admin), every checklist item ticked, and for a checker step a
 * different person than its maker step. Changes the workflow only, never the actor.
 */
export async function completeStep(id: string, stepId: string, by: Actor, input: { checklist?: Record<string, boolean>; comment?: string; evidence_ref?: string; outcome?: "PASS" | "FAIL" } = {}): Promise<{ status: InstanceStatus }> {
  const outcome = input.outcome ?? "PASS";
  const comment = input.comment?.trim() || null;
  if (outcome === "FAIL" && (comment ?? "").length < 5) throw new WorkflowError(400, "NOTE_REQUIRED", "say why in a comment");
  await tx(async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('workflow:' || $1))`, [id]);
    const w = await instanceWithTemplate(id, c);
    if (!w) throw new WorkflowError(404, "NOT_FOUND", "no such workflow");
    const { inst, tpl } = w;
    const step = tpl.steps.find((s) => s.step_id === stepId);
    const events = await eventsOf(id, c);
    const ticked = { ...savedChecklist(stepId, events), ...(input.checklist ?? {}) };
    const no = completeRefusal({
      status: inst.status, currentStepId: inst.current_step_id, step, persona: by.persona, actor: by.email,
      ticked: outcome === "FAIL" ? Object.fromEntries((step?.checklist_items ?? []).map((x) => [x.key, true])) : ticked,
      completedBy: completedByMap(events),
    });
    if (no) throw new WorkflowError(no.code === "WRONG_ROLE" || no.code === "SAME_PERSON" ? 403 : 409, no.code, no.message);
    const clean = Object.fromEntries(step!.checklist_items.map((x) => [x.key, ticked[x.key] === true]));
    await addEvent(c, { instance_id: id, step_id: stepId, event: outcome === "PASS" ? "COMPLETED" : "FAILED", actor: by.email, method: "MANUAL",
      checklist: clean, comment, evidence_ref: input.evidence_ref?.trim() || null });
    await moveOn(c, inst, tpl.steps, stepId, outcome, by.email);
  });
  await audit(by, outcome === "PASS" ? "workflow.step.completed" : "workflow.step.failed", id, { step_id: stepId }, comment ?? undefined);
  const s = await syncInstance(id);
  const after = await rows<{ status: InstanceStatus }>("merchant", `SELECT status FROM workflow_instances WHERE id = $1::uuid`, [id]);
  return { status: after[0]?.status ?? s.status ?? "IN_PROGRESS" };
}

/** Raise the current step with operations (ops alert), and record it. */
export async function escalateStep(id: string, stepId: string, by: Actor, comment: string): Promise<void> {
  const { inst, tpl } = await mustInstance(id);
  if (inst.status !== "IN_PROGRESS") throw new WorkflowError(409, "NOT_IN_PROGRESS", `the workflow is ${inst.status}`);
  const step = tpl.steps.find((s) => s.step_id === stepId);
  if (!step) throw new WorkflowError(404, "NO_SUCH_STEP", "no such step in this workflow");
  const note = comment.trim();
  if (note.length < 5) throw new WorkflowError(400, "NOTE_REQUIRED", "say why in a comment");
  const key = `workflow:escalated:${id}:${stepId}`;
  await tx((c) => addEvent(c, { instance_id: id, step_id: stepId, event: "ESCALATED", actor: by.email, method: "MANUAL", comment: note, evidence_ref: key }));
  await raiseAlert({ key, severity: "WARN", repeatMinutes: 240, title: `Workflow escalated: ${tpl.name} · ${step.name}`,
    body: `${inst.actor_label ?? inst.actor_id}. ${by.email}: ${note}\n/journeys/${id}` });
  await audit(by, "workflow.step.escalated", id, { step_id: stepId }, note);
}

export async function commentStep(id: string, stepId: string, by: Actor, comment: string): Promise<void> {
  const { tpl } = await mustInstance(id);
  if (!tpl.steps.some((s) => s.step_id === stepId)) throw new WorkflowError(404, "NO_SUCH_STEP", "no such step in this workflow");
  const note = comment.trim();
  if (!note) throw new WorkflowError(400, "NOTE_REQUIRED", "write a comment");
  if (note.length > 4000) throw new WorkflowError(400, "TOO_LONG", "at most 4000 characters");
  await tx((c) => addEvent(c, { instance_id: id, step_id: stepId, event: "COMMENT", actor: by.email, method: "MANUAL", comment: note }));
}

/**
 * Close the instance as REJECTED. The actor itself (banker, TSP, MID, merchant) is NOT changed:
 * reject or suspend it on its own page if that is what is meant.
 */
export async function rejectInstance(id: string, by: Actor, comment: string): Promise<void> {
  const note = comment.trim();
  if (note.length < 5) throw new WorkflowError(400, "NOTE_REQUIRED", "say why in a comment");
  await tx(async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('workflow:' || $1))`, [id]);
    const w = await instanceWithTemplate(id, c);
    if (!w) throw new WorkflowError(404, "NOT_FOUND", "no such workflow");
    const { inst, tpl } = w;
    if (inst.status !== "IN_PROGRESS" && inst.status !== "PAUSED") throw new WorkflowError(409, "NOT_OPEN", `the workflow is ${inst.status}`);
    const step = tpl.steps.find((s) => s.step_id === inst.current_step_id) ?? null;
    if (!canReject(by.persona, step)) throw new WorkflowError(403, "WRONG_ROLE", "only a Super Admin, an Admin or the current step's role may reject");
    await addEvent(c, { instance_id: id, step_id: inst.current_step_id ?? tpl.steps[0].step_id, event: "REJECTED", actor: by.email, method: "MANUAL", comment: note });
    await c.query(`UPDATE workflow_instances SET status = 'REJECTED', completed_at = now(), sla_due_at = NULL, updated_at = now() WHERE id = $1::uuid`, [id]);
  });
  await audit(by, "workflow.rejected", id, { status: "REJECTED" }, note);
}

// ── Reading ─────────────────────────────────────────────────────────────────────────────────

export interface InstanceListRow extends InstanceRow {
  template_name: string;
  current_step_name: string | null;
  current_step_type: string | null;
  assigned_role: string | null;
  sla: SlaStatus | null;
  steps_total: number;
  steps_done: number;
}

export interface InstanceFilters { actor_type?: string; template?: string; role?: string; sla?: string; status?: string; actor_id?: string }

export async function listInstances(f: InstanceFilters = {}, now = new Date()): Promise<InstanceListRow[]> {
  const list = await rows<InstanceRow & { steps: StepDef[]; template_name: string; done: string[] | null }>("merchant", `
    SELECT ${I_COLS.split(",").map((c) => `i.${c.trim()}`).join(", ")}, t.steps, t.name AS template_name,
           (SELECT array_agg(DISTINCT e.step_id) FROM workflow_step_events e WHERE e.instance_id = i.id AND e.event = 'COMPLETED') AS done
      FROM workflow_instances i JOIN workflow_templates t ON t.id = i.template_id
     WHERE ($1::text IS NULL OR i.actor_type = $1)
       AND ($2::text IS NULL OR i.template_key = $2)
       AND ($3::text IS NULL OR i.status = $3)
       AND ($4::text IS NULL OR i.actor_id = $4)
     ORDER BY (i.status = 'IN_PROGRESS') DESC, i.initiated_at DESC LIMIT 1000`,
    [f.actor_type || null, f.template || null, f.status || null, f.actor_id || null]);
  return list.map(({ steps, done, ...i }) => {
    const step = steps.find((s) => s.step_id === i.current_step_id) ?? null;
    return {
      ...i,
      current_step_name: step?.name ?? null, current_step_type: step?.step_type ?? null, assigned_role: step?.assigned_role ?? null,
      sla: i.status === "IN_PROGRESS" && step ? slaStatus(i.step_started_at, step.timeout_hours, now) : null,
      steps_total: steps.length, steps_done: steps.filter((s) => (done ?? []).includes(s.step_id)).length,
    };
  }).filter((i) => (!f.role || i.assigned_role === f.role) && (!f.sla || i.sla === f.sla));
}

export interface StepView extends StepDef {
  state: StepState;
  started_at: string | null;
  sla: SlaStatus | null;
  /** The saved ticks (current step). */
  ticked: Record<string, boolean>;
  /** For a step with a system check: whether it holds right now, and what it is. */
  check: { key: string; label: string; passes: boolean } | null;
  /** The linked Maker-Checker request (current MAKER_CHECKER step). */
  mc: McState | null;
  can_complete: boolean;
}

export interface InstanceDetail {
  instance: InstanceRow & { template_name: string; template_description: string | null };
  steps: StepView[];
  events: EventRow[];
  sla: SlaStatus | null;
}

/** One instance, synced first, with its steps as they stand and every event. */
export async function instanceDetail(id: string, viewer: { persona: string }): Promise<InstanceDetail> {
  await syncInstance(id).catch(() => {});
  const { inst, tpl } = await mustInstance(id);
  const events = await eventsOf(id);
  const states = stepStates(tpl.steps, events, inst.current_step_id, inst.status);
  const facts = inst.status === "IN_PROGRESS" ? await loadFacts(inst.actor_type, inst.actor_id).catch(() => null) : null;
  const ctx = { initiated_at: new Date(inst.initiated_at).toISOString() };
  const now = new Date();
  const steps: StepView[] = [];
  for (const s of tpl.steps) {
    const current = s.step_id === inst.current_step_id && inst.status === "IN_PROGRESS";
    const started = [...events].reverse().find((e) => e.step_id === s.step_id && e.event === "STARTED")?.at ?? null;
    steps.push({
      ...s, state: states[s.step_id], started_at: started,
      sla: current ? slaStatus(inst.step_started_at, s.timeout_hours, now) : null,
      ticked: current ? savedChecklist(s.step_id, events) : (states[s.step_id] === "DONE" ? savedChecklist(s.step_id, events) : {}),
      check: s.system_check ? { key: s.system_check, label: checkLabel(s.system_check), passes: facts ? evalSystemCheck(s.system_check, facts, ctx) : false } : null,
      mc: current && s.step_type === "MAKER_CHECKER" && s.mc_action ? await latestMc(s.mc_action, inst.actor_id, null) : null,
      can_complete: current && canActOnStep(viewer.persona, s),
    });
  }
  const cur = tpl.steps.find((s) => s.step_id === inst.current_step_id);
  return {
    instance: { ...inst, template_name: tpl.name, template_description: tpl.description ?? null },
    steps, events,
    sla: inst.status === "IN_PROGRESS" && cur ? slaStatus(inst.step_started_at, cur.timeout_hours, now) : null,
  };
}

/** Open instances whose current step is past its timeout. */
export async function breachedInstances(now = new Date()): Promise<InstanceListRow[]> {
  return (await listInstances({ status: "IN_PROGRESS" }, now)).filter((i) => i.sla === "BREACHED");
}

/**
 * The cron's SLA pass: one alert per breached instance (repeated at most every 6 hours), and the
 * alerts of instances no longer breached closed.
 */
export async function alertBreaches(): Promise<{ breached: number; resolved: number }> {
  const breached = await breachedInstances();
  for (const b of breached)
    await raiseAlert({ key: `workflow:sla:${b.id}`, severity: "WARN", repeatMinutes: 360,
      title: `Workflow SLA breached: ${b.template_name} · ${b.current_step_name ?? ""}`,
      body: `${b.actor_label ?? b.actor_id} has been at "${b.current_step_name}" (${b.assigned_role}) past its timeout. /journeys/${b.id}` });
  const still = new Set(breached.map((b) => `workflow:sla:${b.id}`));
  let resolved = 0;
  for (const a of await openAlerts())
    if (a.alert_key.startsWith("workflow:sla:") && !still.has(a.alert_key)) { await resolveAlert(a.alert_key); resolved++; }
  return { breached: breached.length, resolved };
}

export { isWorkflowRole };
