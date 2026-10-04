// Master Data Management: storage (merchant 0022, provider 0022, routingEngine 0005). Rules are
// in lib/mdm.ts. Staff only: TSP and channel (rail) names are shown here, so nothing from this
// module is ever returned to a merchant or banker login.
//
// Templates, versions and the change log live in merchantservice_db. Custom field values live
// in each master table's `extra` column, in that table's own database. For BANK / TSP / BANKER
// the value and its change-log row are written in one transaction; for MERCHANT (providers) and
// CHANNEL (rails) the value is committed in its own database first and the log row follows.
//
// Core fields are never written here: they stay edited on their own pages (MASTERS.editHref).

import type { PoolClient } from "pg";
import { db, rows, type DbKey } from "@/lib/pg";
import { wormAppend } from "@/lib/worm";
import { requestApproval, type Maker } from "@/lib/maker-checker";
import type { Persona } from "@/lib/auth";
import { maskMid } from "@/lib/chain";
import { ChainError } from "@/lib/chain-store";
import {
  CORE, MASTERS, MASTER_TYPES, activeCustomFields, composeFields, customFields, describeChange, splitByApproval,
  templateProblem, validateExtra, type ExtraChange, type MasterType, type MdmField,
} from "@/lib/mdm";

export const MDM_READ: Persona[] = ["SUPER_ADMIN", "ADMIN", "OPERATOR", "COMPLIANCE", "RISK", "FINANCE"];
export const MDM_WRITE: Persona[] = ["SUPER_ADMIN", "ADMIN"];
export const PAGE_SIZE = 25;
export const MC_TEMPLATE = "mdm.template_update";
export const MC_EXTRA = "mdm.extra_update";

export class MdmError extends Error {
  constructor(public status: number, public code: string, message: string, public extra: Record<string, unknown> = {}) { super(message); }
}

async function tx<T>(key: DbKey, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db(key).connect();
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

const worm = (by: Maker, action: string, type: MasterType, resourceId: string, before: unknown, after: unknown, notes?: string) =>
  wormAppend({ actorId: by.id, actorEmail: by.email, action, resourceType: `mdm_${type.toLowerCase()}`, resourceId, before, after, notes }).catch(() => {});

interface LogRow {
  type: MasterType; recordId: string | null; kind: string; version?: number | null; fieldKey?: string | null;
  before?: unknown; after?: unknown; actor: string; requestId?: string | null; notes?: string | null;
}
async function log(l: LogRow, c?: PoolClient): Promise<void> {
  const sql = `INSERT INTO mdm_change_log (master_type, record_id, kind, version, field_key, before, after, actor, request_id, notes)
               VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)`;
  const args = [l.type, l.recordId, l.kind, l.version ?? null, l.fieldKey ?? null,
    l.before === undefined ? null : JSON.stringify(l.before), l.after === undefined ? null : JSON.stringify(l.after),
    l.actor, l.requestId ?? null, l.notes ?? null];
  if (c) await c.query(sql, args); else await rows("merchant", sql, args);
}

// ── Templates ───────────────────────────────────────────────────────────────────────────────

export interface PendingTemplate { request_id: string; maker_email: string; created_at: string; fields: MdmField[]; changes: string[]; notes: string | null }
export interface Template {
  type: MasterType; version: number; updated_at: string | null;
  /** Core fields from the code (lib/mdm CORE), then the version's custom fields. */
  fields: MdmField[];
  pending: PendingTemplate | null;
}

async function storedVersion(type: MasterType): Promise<{ version: number; fields: MdmField[]; updated_at: string | null }> {
  const r = await rows<{ version: number; fields: MdmField[]; updated_at: string }>("merchant", `
    SELECT t.current_version AS version, v.fields, t.updated_at
      FROM mdm_templates t JOIN mdm_template_versions v ON v.type = t.type AND v.version = t.current_version
     WHERE t.type = $1
  `, [type]);
  if (!r.length) return { version: 1, fields: CORE[type], updated_at: null };
  return { version: r[0].version, fields: composeFields(type, customFields(r[0].fields ?? [])), updated_at: r[0].updated_at };
}

async function pendingTemplate(type: MasterType, current: MdmField[]): Promise<PendingTemplate | null> {
  const r = await rows<{ request_id: string; maker_email: string; created_at: string; payload: any }>("provider", `
    SELECT request_id::text, COALESCE(maker_email, '') AS maker_email, created_at, payload
      FROM maker_checker_requests
     WHERE resource_type = 'mdm_template' AND resource_id = $1 AND action = $2 AND status = 'PENDING'
     ORDER BY created_at DESC LIMIT 1
  `, [type, MC_TEMPLATE]).catch(() => []);
  if (!r.length) return null;
  const fields = composeFields(type, customFields(r[0].payload?.fields ?? []));
  return { request_id: r[0].request_id, maker_email: r[0].maker_email, created_at: r[0].created_at, fields,
    changes: describeChange(current, fields), notes: r[0].payload?.maker_notes ?? null };
}

export async function getTemplate(type: MasterType): Promise<Template> {
  const s = await storedVersion(type);
  return { type, version: s.version, updated_at: s.updated_at, fields: s.fields, pending: await pendingTemplate(type, s.fields) };
}

export interface VersionRow { version: number; created_by: string; approved_by: string | null; created_at: string; custom: number; retired: number; changes: string[]; notes: string | null }

export async function listVersions(type: MasterType): Promise<VersionRow[]> {
  const r = await rows<{ version: number; fields: MdmField[]; created_by: string; approved_by: string | null; created_at: string; notes: string | null }>("merchant", `
    SELECT version, fields, created_by, approved_by, created_at, notes FROM mdm_template_versions WHERE type = $1 ORDER BY version
  `, [type]);
  const out: VersionRow[] = [];
  let prev: MdmField[] = [];
  for (const v of r) {
    const custom = customFields(v.fields ?? []);
    out.push({ version: v.version, created_by: v.created_by, approved_by: v.approved_by, created_at: v.created_at, notes: v.notes,
      custom: custom.filter((f) => !f.retired).length, retired: custom.filter((f) => f.retired).length,
      changes: v.version === 1 ? ["core fields"] : describeChange(prev, v.fields ?? []) });
    prev = v.fields ?? [];
  }
  return out.reverse();
}

/**
 * Propose a new version: the custom fields as they should be (core fields come from the code).
 * Raised as a Maker-Checker request; nothing changes until a second person approves it.
 */
export async function proposeVersion(type: MasterType, custom: MdmField[], by: Maker, notes?: string): Promise<{ request_id: string; changes: string[] }> {
  if (!Array.isArray(custom)) throw new MdmError(400, "INVALID", "custom_fields must be a list");
  const cur = await storedVersion(type);
  const proposed = composeFields(type, custom.filter((f) => f && !f.core));
  const p = templateProblem(type, proposed, cur.fields);
  if (p) throw new MdmError(400, "INVALID_TEMPLATE", p);
  const changes = describeChange(cur.fields, proposed);
  if (!changes.length) throw new MdmError(400, "NO_CHANGE", "the proposed fields are the same as the current version");
  const request_id = await requestApproval({
    resourceType: "mdm_template", resourceId: type, action: MC_TEMPLATE,
    payload: { type, base_version: cur.version, fields: customFields(proposed), maker_email: by.email },
    summary: `${MASTERS[type].label} template v${cur.version + 1}: ${changes.join(", ")}`.slice(0, 300),
    maker: by, notes,
  });
  await log({ type, recordId: null, kind: "TEMPLATE_PROPOSED", version: cur.version + 1, after: { changes, fields: customFields(proposed) }, actor: by.email, requestId: request_id, notes });
  return { request_id, changes };
}

/** Maker-Checker apply for `mdm.template_update`. Refuses a proposal made on an older version. */
export async function applyVersion(requestId: string, payload: any, checker: Maker): Promise<{ type: MasterType; version: number }> {
  const type = payload?.type as MasterType;
  if (!MASTER_TYPES.includes(type)) throw new MdmError(400, "INVALID", "the request names no master type");
  if (payload?.maker_email && payload.maker_email === checker.email) throw new MdmError(403, "SELF_APPROVAL", "the maker cannot approve their own template change");
  const proposed = composeFields(type, customFields(payload?.fields ?? []));
  return tx("merchant", async (c) => {
    const t = await c.query<{ current_version: number }>(`SELECT current_version FROM mdm_templates WHERE type = $1 FOR UPDATE`, [type]);
    const current = t.rows[0]?.current_version ?? 1;
    if (current !== Number(payload?.base_version))
      throw new MdmError(409, "STALE", `the template is at v${current}; this change was proposed on v${payload?.base_version}. Reject it and propose again`);
    const curFields = (await c.query<{ fields: MdmField[] }>(`SELECT fields FROM mdm_template_versions WHERE type = $1 AND version = $2`, [type, current])).rows[0]?.fields ?? CORE[type];
    const p = templateProblem(type, proposed, composeFields(type, customFields(curFields)));
    if (p) throw new MdmError(400, "INVALID_TEMPLATE", p);
    const version = current + 1;
    await c.query(`INSERT INTO mdm_template_versions (type, version, fields, created_by, approved_by, request_id, notes)
                   VALUES ($1, $2, $3::jsonb, $4, $5, $6::uuid, $7)`,
      [type, version, JSON.stringify(proposed), payload?.maker_email ?? "unknown", checker.email, requestId, payload?.maker_notes ?? null]);
    await c.query(`UPDATE mdm_templates SET current_version = $2, updated_at = now() WHERE type = $1`, [type, version]);
    const changes = describeChange(curFields, proposed);
    await log({ type, recordId: null, kind: "TEMPLATE_APPLIED", version, before: { version: current }, after: { version, changes }, actor: checker.email, requestId }, c);
    await worm(checker, "mdm.template.applied", type, type, { version: current }, { version, changes, request_id: requestId });
    return { type, version };
  });
}

export async function rejectVersion(requestId: string, payload: any, checker: Maker): Promise<void> {
  const type = payload?.type as MasterType;
  if (!MASTER_TYPES.includes(type)) return;
  await log({ type, recordId: null, kind: "TEMPLATE_REJECTED", version: Number(payload?.base_version) + 1, actor: checker.email, requestId });
}

// ── Records ─────────────────────────────────────────────────────────────────────────────────

/** SELECT list for a type's core columns: sensitive ones only say whether they are set. */
function coreSelect(type: MasterType, keys?: string[]): string {
  const want = keys ? CORE[type].filter((f) => keys.includes(f.key)) : CORE[type];
  return want.map((f) => f.sensitive ? `(t.${f.key} IS NOT NULL AND t.${f.key}::text <> '') AS ${f.key}`
    : f.type === "uuid" ? `t.${f.key}::text AS ${f.key}` : `t.${f.key}`).join(", ");
}

export interface ListedRecord { id: string; title: string; core: Record<string, unknown>; extra: Record<string, unknown>; relations: Record<string, number> }
export interface RecordList { type: MasterType; rows: ListedRecord[]; total: number; page: number; page_size: number; fields: MdmField[]; version: number }

const RELATION_COUNTS: Partial<Record<MasterType, string>> = {
  BANK: `(SELECT COUNT(*)::int FROM tsp_banks tb WHERE tb.bank_id = t.id AND tb.status = 'CONFIRMED') AS "TSPs",
         (SELECT COUNT(*)::int FROM merchants m WHERE m.issuing_bank_id = t.id) AS "Bankers",
         (SELECT COUNT(*)::int FROM issued_mids i WHERE i.bank_id = t.id AND i.status = 'ACTIVE') AS "MIDs"`,
  TSP: `(SELECT COUNT(*)::int FROM tsp_banks tb WHERE tb.tsp_id = t.id AND tb.status = 'CONFIRMED') AS "Banks",
        (SELECT COUNT(*)::int FROM merchants m WHERE m.parent_tsp_id = t.id) AS "Bankers",
        (SELECT COUNT(*)::int FROM issued_mids i WHERE i.tsp_id = t.id AND i.status = 'ACTIVE') AS "MIDs"`,
  BANKER: `(CASE WHEN t.parent_tsp_id IS NULL THEN 0 ELSE 1 END) AS "TSP",
           (CASE WHEN t.issuing_bank_id IS NULL THEN 0 ELSE 1 END) AS "Bank",
           (SELECT COUNT(*)::int FROM issued_mids i WHERE i.merchant_id = t.id AND i.status = 'ACTIVE') AS "MIDs"`,
};

export async function listRecords(type: MasterType, opts: { page?: number; q?: string } = {}): Promise<RecordList> {
  const m = MASTERS[type];
  const page = Math.max(1, Math.floor(Number(opts.page) || 1));
  const q = (opts.q ?? "").trim().slice(0, 100);
  const args: unknown[] = [];
  let where = "";
  if (q) {
    args.push(`%${q.replace(/[\\%_]/g, (x) => "\\" + x)}%`, q);
    where = `WHERE (${m.search.map((k) => `t.${k} ILIKE $1`).join(" OR ")} OR t.id::text = $2)`;
  }
  const total = (await rows<{ n: number }>(m.db, `SELECT COUNT(*)::int AS n FROM ${m.table} t ${where}`, args))[0]?.n ?? 0;
  const rel = RELATION_COUNTS[type];
  const order = type === "CHANNEL" ? "t.direction, t.provider, t.method, t.id" : type === "BANKER" ? "t.merchant_code, t.id" : "t.code, t.id";
  const data = await rows<any>(m.db, `
    SELECT t.id::text AS id, ${coreSelect(type, [...new Set([...m.summary, m.title])])}, t.extra${rel ? ", " + rel : ""}
      FROM ${m.table} t ${where}
     ORDER BY ${order}
     LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}
  `, args);
  const relLabels = type === "BANK" ? ["TSPs", "Bankers", "MIDs"] : type === "TSP" ? ["Banks", "Bankers", "MIDs"] : type === "BANKER" ? ["TSP", "Bank", "MIDs"] : [];
  const out: ListedRecord[] = data.map((r) => {
    const core: Record<string, unknown> = {};
    for (const k of m.summary) core[k] = r[k];
    const relations: Record<string, number> = {};
    for (const l of relLabels) relations[l] = Number(r[l] ?? 0);
    return { id: r.id, title: String(r[m.title] ?? r.id), core, extra: r.extra ?? {}, relations };
  });
  const ids = out.map((r) => r.id);
  if (ids.length && type === "BANKER") {
    const map = await rows<{ merchant_id: string; n: number }>("provider", `
      SELECT merchant_id::text, COUNT(*)::int AS n FROM provider_merchant_mappings
       WHERE merchant_id = ANY($1::uuid[]) AND status = 'ACTIVE' GROUP BY merchant_id
    `, [ids]).catch(() => []);
    for (const r of out) r.relations.Merchant = map.find((x) => x.merchant_id === r.id)?.n ?? 0;
  }
  if (ids.length && type === "MERCHANT") {
    const map = await rows<{ provider_id: string; n: number }>("provider", `
      SELECT provider_id::text, COUNT(*)::int AS n FROM provider_merchant_mappings
       WHERE provider_id = ANY($1::uuid[]) AND status = 'ACTIVE' GROUP BY provider_id
    `, [ids]).catch(() => []);
    for (const r of out) r.relations.Bankers = map.find((x) => x.provider_id === r.id)?.n ?? 0;
  }
  const t = await storedVersion(type);
  return { type, rows: out, total, page, page_size: PAGE_SIZE, fields: t.fields, version: t.version };
}

export interface RelatedItem { id: string; label: string; sub?: string; href?: string }
export interface Relationship { key: string; label: string; target: MasterType | "MID"; items: RelatedItem[] }
export interface ChangeRow { id: string; kind: string; version: number | null; field_key: string | null; before: unknown; after: unknown; actor: string; request_id: string | null; notes: string | null; at: string }
export interface MasterRecord {
  type: MasterType; id: string; title: string; edit_href: string; version: number;
  fields: MdmField[]; core: Record<string, unknown>; extra: Record<string, unknown>;
  relationships: Relationship[]; history: ChangeRow[]; pending_extra: { request_id: string; values: Record<string, unknown>; maker_email: string; created_at: string } | null;
}

const href = (t: MasterType, id: string) => `/mdm/${t.toLowerCase()}/${id}`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function midsWhere(col: "bank_id" | "tsp_id" | "merchant_id", id: string): Promise<RelatedItem[]> {
  const r = await rows<{ id: string; mid_value: string; flow: string; status: string; merchant_code: string | null }>("merchant", `
    SELECT i.id::text, i.mid_value, i.flow, i.status, m.merchant_code
      FROM issued_mids i LEFT JOIN merchants m ON m.id = i.merchant_id
     WHERE i.${col} = $1::uuid AND i.status IN ('ACTIVE','PENDING_APPROVAL','INACTIVE')
     ORDER BY i.created_at DESC LIMIT 100
  `, [id]).catch(() => []);
  return r.map((x) => ({ id: x.id, label: maskMid(x.mid_value), sub: `${x.flow} · ${x.status}${x.merchant_code && col !== "merchant_id" ? " · " + x.merchant_code : ""}` }));
}

async function relationships(type: MasterType, id: string, core: Record<string, unknown>): Promise<Relationship[]> {
  switch (type) {
    case "BANK": {
      const tsps = await rows<{ id: string; code: string; name: string; status: string }>("merchant", `
        SELECT t.id::text, t.code, t.name, tb.status FROM tsp_banks tb JOIN tsps t ON t.id = tb.tsp_id
         WHERE tb.bank_id = $1::uuid AND tb.status <> 'ENDED' ORDER BY t.code`, [id]);
      const bankers = await rows<{ id: string; merchant_code: string; legal_name: string; stage: string }>("merchant", `
        SELECT id::text, merchant_code, legal_name, stage FROM merchants WHERE issuing_bank_id = $1::uuid ORDER BY merchant_code LIMIT 200`, [id]);
      return [
        { key: "tsps", label: "TSPs", target: "TSP", items: tsps.map((t) => ({ id: t.id, label: `${t.code} · ${t.name}`, sub: t.status === "CONFIRMED" ? "Confirmed" : "Pending", href: href("TSP", t.id) })) },
        { key: "bankers", label: "Bankers issued", target: "BANKER", items: bankers.map((b) => ({ id: b.id, label: `${b.merchant_code} · ${b.legal_name}`, sub: b.stage, href: href("BANKER", b.id) })) },
        { key: "mids", label: "MIDs", target: "MID", items: await midsWhere("bank_id", id) },
      ];
    }
    case "TSP": {
      const banks = await rows<{ id: string; code: string; name: string; status: string }>("merchant", `
        SELECT b.id::text, b.code, b.name, tb.status FROM tsp_banks tb JOIN banks b ON b.id = tb.bank_id
         WHERE tb.tsp_id = $1::uuid AND tb.status <> 'ENDED' ORDER BY b.code`, [id]);
      const bankers = await rows<{ id: string; merchant_code: string; legal_name: string; stage: string }>("merchant", `
        SELECT id::text, merchant_code, legal_name, stage FROM merchants WHERE parent_tsp_id = $1::uuid ORDER BY merchant_code LIMIT 200`, [id]);
      return [
        { key: "banks", label: "Banks", target: "BANK", items: banks.map((b) => ({ id: b.id, label: `${b.code} · ${b.name}`, sub: b.status === "CONFIRMED" ? "Confirmed" : "Pending", href: href("BANK", b.id) })) },
        { key: "bankers", label: "Bankers", target: "BANKER", items: bankers.map((b) => ({ id: b.id, label: `${b.merchant_code} · ${b.legal_name}`, sub: b.stage, href: href("BANKER", b.id) })) },
        { key: "mids", label: "MIDs", target: "MID", items: await midsWhere("tsp_id", id) },
      ];
    }
    case "BANKER": {
      const chain = await rows<{ tsp_id: string | null; tsp: string | null; bank_id: string | null; bank: string | null }>("merchant", `
        SELECT t.id::text AS tsp_id, t.code || ' · ' || t.name AS tsp, b.id::text AS bank_id, b.code || ' · ' || b.name AS bank
          FROM merchants m LEFT JOIN tsps t ON t.id = m.parent_tsp_id LEFT JOIN banks b ON b.id = m.issuing_bank_id
         WHERE m.id = $1::uuid`, [id]);
      const c0 = chain[0];
      const map = await rows<{ id: string; code: string; legal_name: string }>("provider", `
        SELECT p.id::text, p.code, p.legal_name FROM provider_merchant_mappings pm JOIN providers p ON p.id = pm.provider_id
         WHERE pm.merchant_id = $1::uuid AND pm.status = 'ACTIVE' ORDER BY pm.mapped_at DESC`, [id]).catch(() => []);
      return [
        { key: "merchant", label: "Merchant", target: "MERCHANT", items: map.map((p) => ({ id: p.id, label: `${p.code} · ${p.legal_name}`, href: href("MERCHANT", p.id) })) },
        { key: "tsp", label: "TSP", target: "TSP", items: c0?.tsp_id ? [{ id: c0.tsp_id, label: c0.tsp ?? c0.tsp_id, href: href("TSP", c0.tsp_id) }] : [] },
        { key: "bank", label: "Issuing bank", target: "BANK", items: c0?.bank_id ? [{ id: c0.bank_id, label: c0.bank ?? c0.bank_id, href: href("BANK", c0.bank_id) }] : [] },
        { key: "mids", label: "MIDs", target: "MID", items: await midsWhere("merchant_id", id) },
      ];
    }
    case "MERCHANT": {
      const map = await rows<{ merchant_id: string }>("provider", `
        SELECT merchant_id::text FROM provider_merchant_mappings WHERE provider_id = $1::uuid AND status = 'ACTIVE'`, [id]);
      const ids = map.map((x) => x.merchant_id);
      const bankers = ids.length ? await rows<{ id: string; merchant_code: string; legal_name: string; stage: string }>("merchant", `
        SELECT id::text, merchant_code, legal_name, stage FROM merchants WHERE id = ANY($1::uuid[]) ORDER BY merchant_code`, [ids]) : [];
      return [{ key: "bankers", label: "Bankers", target: "BANKER", items: bankers.map((b) => ({ id: b.id, label: `${b.merchant_code} · ${b.legal_name}`, sub: b.stage, href: href("BANKER", b.id) })) }];
    }
    default:
      void core;
      return [];
  }
}

async function pendingExtra(type: MasterType, id: string): Promise<MasterRecord["pending_extra"]> {
  const r = await rows<{ request_id: string; payload: any; maker_email: string; created_at: string }>("provider", `
    SELECT request_id::text, payload, COALESCE(maker_email,'') AS maker_email, created_at FROM maker_checker_requests
     WHERE resource_type = $1 AND resource_id = $2 AND action = $3 AND status = 'PENDING' ORDER BY created_at DESC LIMIT 1
  `, [`mdm_${type.toLowerCase()}`, id, MC_EXTRA]).catch(() => []);
  return r.length ? { request_id: r[0].request_id, values: r[0].payload?.values ?? {}, maker_email: r[0].maker_email, created_at: r[0].created_at } : null;
}

export async function getRecord(type: MasterType, id: string): Promise<MasterRecord> {
  if (!UUID_RE.test(id)) throw new MdmError(404, "NOT_FOUND", `${MASTERS[type].label.toLowerCase()} not found`);
  const m = MASTERS[type];
  const r = await rows<any>(m.db, `SELECT ${coreSelect(type)}, t.extra FROM ${m.table} t WHERE t.id = $1::uuid`, [id]);
  if (!r.length) throw new MdmError(404, "NOT_FOUND", `${m.label.toLowerCase()} not found`);
  const { extra, ...core } = r[0];
  const t = await storedVersion(type);
  const history = await rows<ChangeRow>("merchant", `
    SELECT id::text, kind, version, field_key, before, after, actor, request_id, notes, at FROM mdm_change_log
     WHERE master_type = $1 AND record_id = $2 ORDER BY at DESC, id DESC LIMIT 200
  `, [type, id]);
  return {
    type, id, title: String(core[m.title] ?? id), edit_href: m.editHref(id), version: t.version, fields: t.fields,
    core, extra: extra ?? {}, relationships: await relationships(type, id, core), history, pending_extra: await pendingExtra(type, id),
  };
}

/** Write changed extra values to a record, in its own database, with the log rows. */
async function writeExtra(type: MasterType, id: string, fields: MdmField[], patch: Record<string, unknown>, only: Set<string> | null,
  by: Maker, version: number, requestId: string | null): Promise<ExtraChange[]> {
  const m = MASTERS[type];
  const sameDb = m.db === "merchant";
  const done = await tx(m.db, async (c) => {
    const cur = await c.query<{ extra: Record<string, unknown> }>(`SELECT extra FROM ${m.table} WHERE id = $1::uuid FOR UPDATE`, [id]);
    if (!cur.rows.length) throw new MdmError(404, "NOT_FOUND", `${m.label.toLowerCase()} not found`);
    const sub = only ? Object.fromEntries(Object.entries(patch).filter(([k]) => only.has(k))) : patch;
    const v = validateExtra(fields, cur.rows[0].extra ?? {}, sub);
    if (!v.ok) throw new MdmError(400, "INVALID_VALUES", "some values are not valid", { errors: v.errors });
    if (!v.changes.length) return v.changes;
    await c.query(`UPDATE ${m.table} SET extra = $2::jsonb WHERE id = $1::uuid`, [id, JSON.stringify(v.next)]);
    if (sameDb) for (const ch of v.changes)
      await log({ type, recordId: id, kind: "EXTRA_SET", version, fieldKey: ch.key, before: ch.before, after: ch.after, actor: by.email, requestId }, c);
    return v.changes;
  });
  if (!sameDb) for (const ch of done)
    await log({ type, recordId: id, kind: "EXTRA_SET", version, fieldKey: ch.key, before: ch.before, after: ch.after, actor: by.email, requestId });
  if (done.length) await worm(by, "mdm.extra.set", type, id, Object.fromEntries(done.map((c) => [c.key, c.before])),
    Object.fromEntries(done.map((c) => [c.key, c.after])), requestId ? `approved request ${requestId}` : undefined);
  return done;
}

/**
 * Set custom field values on a record. Values for a field marked `requires_approval` are raised
 * as one Maker-Checker request (`mdm.extra_update`) and applied when approved; the rest are
 * applied at once. A blank value clears the field.
 */
export async function setExtra(type: MasterType, id: string, values: Record<string, unknown>, by: Maker, notes?: string):
  Promise<{ applied: ExtraChange[]; pending: ExtraChange[]; request_id: string | null }> {
  if (!UUID_RE.test(id)) throw new MdmError(404, "NOT_FOUND", `${MASTERS[type].label.toLowerCase()} not found`);
  const m = MASTERS[type];
  const t = await storedVersion(type);
  const cur = await rows<{ extra: Record<string, unknown> }>(m.db, `SELECT extra FROM ${m.table} WHERE id = $1::uuid`, [id]);
  if (!cur.length) throw new MdmError(404, "NOT_FOUND", `${m.label.toLowerCase()} not found`);
  const v = validateExtra(t.fields, cur[0].extra ?? {}, values);
  if (!v.ok) throw new MdmError(400, "INVALID_VALUES", "some values are not valid", { errors: v.errors });
  const { direct, approval } = splitByApproval(t.fields, v.changes);
  let request_id: string | null = null;
  if (approval.length) {
    const vals = Object.fromEntries(approval.map((c) => [c.key, c.after]));
    request_id = await requestApproval({
      resourceType: `mdm_${type.toLowerCase()}`, resourceId: id, action: MC_EXTRA,
      payload: { type, id, values: vals, template_version: t.version, maker_email: by.email },
      summary: `${m.label} ${String(id).slice(0, 8)}: set ${approval.map((c) => c.key).join(", ")}`,
      maker: by, notes,
    });
    for (const ch of approval)
      await log({ type, recordId: id, kind: "EXTRA_PROPOSED", version: t.version, fieldKey: ch.key, before: ch.before, after: ch.after, actor: by.email, requestId: request_id, notes });
  }
  const applied = direct.length
    ? await writeExtra(type, id, t.fields, values, new Set(direct.map((c) => c.key)), by, t.version, null)
    : [];
  return { applied, pending: approval, request_id };
}

/** Maker-Checker apply for `mdm.extra_update`: re-checked against the template in force now. */
export async function applyExtra(requestId: string, payload: any, checker: Maker): Promise<{ applied: ExtraChange[] }> {
  const type = payload?.type as MasterType;
  if (!MASTER_TYPES.includes(type)) throw new MdmError(400, "INVALID", "the request names no master type");
  if (payload?.maker_email && payload.maker_email === checker.email) throw new MdmError(403, "SELF_APPROVAL", "the maker cannot approve their own change");
  const t = await storedVersion(type);
  const values = payload?.values && typeof payload.values === "object" ? payload.values : {};
  return { applied: await writeExtra(type, String(payload?.id), t.fields, values, null, checker, t.version, requestId) };
}

export async function rejectExtra(requestId: string, payload: any, checker: Maker): Promise<void> {
  const type = payload?.type as MasterType;
  if (!MASTER_TYPES.includes(type)) return;
  for (const key of Object.keys(payload?.values ?? {}))
    await log({ type, recordId: String(payload?.id), kind: "EXTRA_REJECTED", fieldKey: key, after: payload.values[key], actor: checker.email, requestId });
}

// ── Home ────────────────────────────────────────────────────────────────────────────────────

export interface HomeCard {
  type: MasterType; label: string; plural: string; description: string;
  records: number | null; version: number; core_fields: number; custom_fields: number; retired_fields: number;
  with_values: number | null; last_change: string | null; pending_template: boolean;
}

export async function home(): Promise<HomeCard[]> {
  const last = await rows<{ master_type: MasterType; at: string }>("merchant", `SELECT master_type, MAX(at) AS at FROM mdm_change_log GROUP BY master_type`);
  const pend = await rows<{ resource_id: string }>("provider", `
    SELECT resource_id FROM maker_checker_requests WHERE resource_type = 'mdm_template' AND action = $1 AND status = 'PENDING'`, [MC_TEMPLATE]).catch(() => []);
  return Promise.all(MASTER_TYPES.map(async (type): Promise<HomeCard> => {
    const m = MASTERS[type];
    const t = await storedVersion(type);
    const counts = await rows<{ n: number; v: number }>(m.db, `SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE extra <> '{}'::jsonb)::int AS v FROM ${m.table}`).catch(() => []);
    const custom = customFields(t.fields);
    return {
      type, label: m.label, plural: m.plural, description: m.description,
      records: counts[0]?.n ?? null, with_values: counts[0]?.v ?? null, version: t.version,
      core_fields: CORE[type].length, custom_fields: activeCustomFields(t.fields).length, retired_fields: custom.filter((f) => f.retired).length,
      last_change: last.find((l) => l.master_type === type)?.at ?? t.updated_at, pending_template: pend.some((p) => p.resource_id === type),
    };
  }));
}

// ── Maker-Checker entry points (registered in lib/maker-checker-actions) ────────────────────
// The Maker-Checker route returns a ChainError's message and status to the checker; any other
// error is a 500. An MdmError is passed on as one so the checker sees why.


async function forChecker<T>(p: Promise<T>): Promise<T> {
  try { return await p; } catch (e) {
    if (e instanceof MdmError) throw new ChainError(e.status, e.code, e.message, e.extra);
    throw e;
  }
}
export interface McRequestLike { request_id: string; payload: Record<string, any> }
export const mcApplyTemplate = (r: McRequestLike, c: Maker) => forChecker(applyVersion(r.request_id, r.payload, c));
export const mcRejectTemplate = (r: McRequestLike, c: Maker) => rejectVersion(r.request_id, r.payload, c);
export const mcApplyExtra = (r: McRequestLike, c: Maker) => forChecker(applyExtra(r.request_id, r.payload, c));
export const mcRejectExtra = (r: McRequestLike, c: Maker) => rejectExtra(r.request_id, r.payload, c);
