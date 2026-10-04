// Storage for the Bank → TSP → Banker chain (merchant 0018). Rules are in lib/chain.ts.
// Staff only: nothing here is ever returned to a merchant or banker login.

import type { PoolClient } from "pg";
import { db, rows } from "@/lib/pg";
import { wormAppend } from "@/lib/worm";
import { openText, sealOptional } from "@/lib/sealed-text";
import { requestApproval, withdrawRequest, type Maker } from "@/lib/maker-checker";
import { screenNames, type GateOutcome } from "@/lib/onboarding-gates";
import type { Persona } from "@/lib/auth";
import {
  bankInputProblem, chainRefusal, maskAccount, midInputProblem, midIssueRefusal, tspChecklist, tspInputProblem, tspNextStep,
  healthScore, TSP_LOCKED_WHEN_LIVE, TSP_DOC_TYPES,
  type BankInput, type ChecklistItem, type Flow, type MidInput, type MidStatus, type Refusal, type Tsp, type TspDocType, type TspFacts, type TspInput,
} from "@/lib/chain";

export const CHAIN_READ: Persona[] = ["SUPER_ADMIN", "ADMIN", "OPERATOR", "COMPLIANCE", "RISK", "FINANCE"];
export const CHAIN_WRITE: Persona[] = ["SUPER_ADMIN", "ADMIN"];
/** Document review and screening. */
export const CHAIN_REVIEW: Persona[] = ["SUPER_ADMIN", "ADMIN", "COMPLIANCE"];

/** A refusal the routes return as `{ error, code }` with this status. */
export class ChainError extends Error {
  constructor(public status: number, public code: string, message: string, public extra: Record<string, unknown> = {}) { super(message); }
}
const refuse = (r: Refusal, status = 409): never => { throw new ChainError(status, r.code, r.message); };

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

const audit = (by: Maker, action: string, resourceType: string, resourceId: string, before: unknown, after: unknown, notes?: string) =>
  wormAppend({ actorId: by.id, actorEmail: by.email, action, resourceType, resourceId, before, after, notes }).catch(() => {});

// ── Banks ───────────────────────────────────────────────────────────────────────────────────

export interface BankRow {
  id: string; code: string; name: string; bank_type: string; settlement_account: string | null;
  neft_enabled: boolean; imps_enabled: boolean; upi_enabled: boolean; contact_email: string | null; status: "ACTIVE" | "INACTIVE";
  tsps: number; bankers: number; created_at: string; updated_at: string;
}

export async function listBanks(): Promise<BankRow[]> {
  const r = await rows<BankRow>("merchant", `
    SELECT b.id::text, b.code, b.name, b.bank_type, b.settlement_account, b.neft_enabled, b.imps_enabled, b.upi_enabled,
           b.contact_email, b.status, b.created_at, b.updated_at,
           (SELECT COUNT(*)::int FROM tsp_banks tb WHERE tb.bank_id = b.id AND tb.status = 'CONFIRMED') AS tsps,
           (SELECT COUNT(*)::int FROM merchants m WHERE m.issuing_bank_id = b.id) AS bankers
      FROM banks b ORDER BY b.code
  `);
  return r.map((b) => ({ ...b, settlement_account: maskAccount(openText(b.settlement_account)) }));
}

const BANK_COLS = ["name", "bank_type", "settlement_account", "neft_enabled", "imps_enabled", "upi_enabled", "contact_email", "status"] as const;

export async function createBank(i: BankInput, by: Maker): Promise<{ id: string }> {
  const p = bankInputProblem(i, true);
  if (p) throw new ChainError(400, "INVALID", p);
  const r = await rows<{ id: string }>("merchant", `
    INSERT INTO banks (code, name, bank_type, settlement_account, neft_enabled, imps_enabled, upi_enabled, contact_email, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (code) DO NOTHING RETURNING id::text
  `, [i.code, i.name!.trim(), i.bank_type, sealOptional(i.settlement_account?.replace(/\s/g, "") || null),
      i.neft_enabled ?? true, i.imps_enabled ?? true, i.upi_enabled ?? true, i.contact_email?.trim() || null, by.email]);
  if (!r.length) throw new ChainError(409, "CODE_TAKEN", `a bank with code ${i.code} exists`);
  await audit(by, "bank.created", "bank", r[0].id, null, { ...i, settlement_account: maskAccount(i.settlement_account) });
  return r[0];
}

export async function updateBank(id: string, i: BankInput, by: Maker): Promise<void> {
  const p = bankInputProblem(i, false);
  if (p) throw new ChainError(400, "INVALID", p);
  const sets: string[] = []; const args: unknown[] = [id];
  for (const k of BANK_COLS) {
    if (i[k] === undefined) continue;
    let v: unknown = i[k];
    if (k === "settlement_account") v = sealOptional((i.settlement_account ?? "").replace(/\s/g, "") || null);
    if (k === "contact_email" || k === "name") v = (v as string | null)?.trim() || null;
    args.push(v); sets.push(`${k} = $${args.length}`);
  }
  if (!sets.length) return;
  const before = await rows("merchant", `SELECT code, name, bank_type, status, contact_email FROM banks WHERE id = $1::uuid`, [id]);
  if (!before.length) throw new ChainError(404, "NOT_FOUND", "bank not found");
  await rows("merchant", `UPDATE banks SET ${sets.join(", ")}, updated_at = now() WHERE id = $1::uuid`, args);
  await audit(by, "bank.updated", "bank", id, before[0], { ...i, settlement_account: i.settlement_account === undefined ? undefined : maskAccount(i.settlement_account) });
}

// ── TSPs ────────────────────────────────────────────────────────────────────────────────────

const TSP_COLS = `t.id::text, t.code, t.name, t.legal_name, t.tsp_type, t.gateway_code, t.rbi_licence_no, t.pci_dss_cert_no,
  t.primary_contact_name, t.primary_contact_email, t.primary_contact_phone, t.compliance_officer_name, t.compliance_officer_email,
  t.allowed_flows, t.max_mids_per_banker, t.max_bankers, t.stage, t.screening_result, t.screened_by, t.screened_at, t.notes,
  t.created_by, t.created_at, t.updated_at`;

export type TspRow = Tsp & { screened_by: string | null; screened_at: string | null; notes: string | null; created_by: string | null; created_at: string; updated_at: string };

export interface TspListRow extends TspRow {
  confirmed_banks: number; bankers: number; live_bankers: number; active_mids: number; pending_requests: number; score: number;
}

export async function listTsps(): Promise<TspListRow[]> {
  const list = await rows<TspRow & { confirmed_banks: number; bankers: number; live_bankers: number; active_mids: number }>("merchant", `
    SELECT ${TSP_COLS},
           (SELECT COUNT(*)::int FROM tsp_banks tb WHERE tb.tsp_id = t.id AND tb.status = 'CONFIRMED') AS confirmed_banks,
           (SELECT COUNT(*)::int FROM merchants m WHERE m.parent_tsp_id = t.id) AS bankers,
           (SELECT COUNT(*)::int FROM merchants m WHERE m.parent_tsp_id = t.id AND m.stage = 'LIVE') AS live_bankers,
           (SELECT COUNT(*)::int FROM issued_mids i WHERE i.tsp_id = t.id AND i.status = 'ACTIVE') AS active_mids
      FROM tsps t ORDER BY t.code
  `);
  const facts = await tspFactsMany(list.map((t) => t.id));
  const pending = await pendingTspRequests(list.map((t) => t.id));
  return list.map((t) => ({ ...t, pending_requests: pending.get(t.id) ?? 0, score: healthScore(tspChecklist(t, facts.get(t.id)!)) }));
}

async function pendingTspRequests(ids: string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const r = await rows<{ resource_id: string; n: number }>("provider", `
    SELECT resource_id, COUNT(*)::int AS n FROM maker_checker_requests
     WHERE resource_type = 'tsp' AND status = 'PENDING' AND resource_id = ANY($1::text[]) GROUP BY 1
  `, [ids]).catch(() => []);
  return new Map(r.map((x) => [x.resource_id, x.n]));
}

async function tspFactsMany(ids: string[]): Promise<Map<string, TspFacts>> {
  const out = new Map<string, TspFacts>(ids.map((id) => [id, { approvedDocs: [], pendingDocs: [], confirmedBanks: 0, liveBankers: 0 }]));
  if (!ids.length) return out;
  const docs = await rows<{ tsp_id: string; doc_type: TspDocType; review: string }>("merchant", `
    SELECT DISTINCT tsp_id::text, doc_type, review FROM tsp_documents WHERE tsp_id = ANY($1::uuid[])
  `, [ids]);
  for (const d of docs) {
    const f = out.get(d.tsp_id)!;
    if (d.review === "APPROVED") f.approvedDocs.push(d.doc_type);
    if (d.review === "PENDING") f.pendingDocs.push(d.doc_type);
  }
  const counts = await rows<{ id: string; banks: number; live: number }>("merchant", `
    SELECT t.id::text,
           (SELECT COUNT(*)::int FROM tsp_banks tb WHERE tb.tsp_id = t.id AND tb.status = 'CONFIRMED') AS banks,
           (SELECT COUNT(*)::int FROM merchants m WHERE m.parent_tsp_id = t.id AND m.stage = 'LIVE') AS live
      FROM tsps t WHERE t.id = ANY($1::uuid[])
  `, [ids]);
  for (const c of counts) { const f = out.get(c.id)!; f.confirmedBanks = c.banks; f.liveBankers = c.live; }
  return out;
}

export async function getTsp(id: string): Promise<TspRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return (await rows<TspRow>("merchant", `SELECT ${TSP_COLS} FROM tsps t WHERE t.id = $1::uuid`, [id]))[0] ?? null;
}

async function mustTsp(id: string): Promise<TspRow> {
  const t = await getTsp(id);
  if (!t) throw new ChainError(404, "NOT_FOUND", "TSP not found");
  return t;
}

export interface TspDetail {
  tsp: TspRow;
  checklist: ChecklistItem[];
  score: number;
  next: ReturnType<typeof tspNextStep>;
  banks: { bank_id: string; code: string; name: string; status: string; reference: string | null; confirmed_by: string | null; confirmed_at: string | null }[];
  documents: { id: string; doc_type: string; filename: string | null; size_bytes: string; sha256: string; review: string; reviewed_by: string | null; reviewed_at: string | null; review_note: string | null; uploaded_by: string | null; created_at: string }[];
  bankers: { id: string; merchant_code: string; legal_name: string; stage: string; bank_code: string | null; active_mids: number }[];
  mid_quota: { flow: Flow; active: number; pending: number }[];
  history: { from_stage: string | null; to_stage: string; changed_at: string }[];
  pending_requests: { request_id: string; action: string; summary: string; maker_email: string; created_at: string }[];
}

export async function tspDetail(id: string): Promise<TspDetail> {
  const tsp = await mustTsp(id);
  const facts = (await tspFactsMany([id])).get(id)!;
  const checklist = tspChecklist(tsp, facts);
  const [banks, documents, bankers, quota, history, pending] = await Promise.all([
    rows<TspDetail["banks"][number]>("merchant", `
      SELECT tb.bank_id::text, b.code, b.name, tb.status, tb.reference, tb.confirmed_by, tb.confirmed_at
        FROM tsp_banks tb JOIN banks b ON b.id = tb.bank_id WHERE tb.tsp_id = $1::uuid ORDER BY b.code`, [id]),
    rows<TspDetail["documents"][number]>("merchant", `
      SELECT id::text, doc_type, filename, size_bytes::text, sha256, review, reviewed_by, reviewed_at, review_note, uploaded_by, created_at
        FROM tsp_documents WHERE tsp_id = $1::uuid ORDER BY created_at DESC`, [id]),
    rows<TspDetail["bankers"][number]>("merchant", `
      SELECT m.id::text, m.merchant_code, m.legal_name, m.stage, b.code AS bank_code,
             (SELECT COUNT(*)::int FROM issued_mids i WHERE i.merchant_id = m.id AND i.status = 'ACTIVE') AS active_mids
        FROM merchants m LEFT JOIN banks b ON b.id = m.issuing_bank_id
       WHERE m.parent_tsp_id = $1::uuid ORDER BY m.merchant_code`, [id]),
    rows<{ flow: Flow; active: number; pending: number }>("merchant", `
      SELECT flow, COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active, COUNT(*) FILTER (WHERE status = 'PENDING_APPROVAL')::int AS pending
        FROM issued_mids WHERE tsp_id = $1::uuid GROUP BY flow ORDER BY flow`, [id]),
    rows<TspDetail["history"][number]>("merchant", `
      SELECT from_stage, to_stage, changed_at FROM tsp_stage_history h WHERE tsp_id = $1::uuid ORDER BY h.id DESC LIMIT 50`, [id]),
    rows<{ request_id: string; action: string; payload: { summary?: string }; maker_email: string; created_at: string }>("provider", `
      SELECT request_id::text, action, payload, COALESCE(maker_email, '') AS maker_email, created_at FROM maker_checker_requests
       WHERE status = 'PENDING' AND ((resource_type = 'tsp' AND resource_id = $1)
          OR (resource_type = 'issued_mid' AND payload->>'tsp_id' = $1)) ORDER BY created_at`, [id]).catch(() => []),
  ]);
  return {
    tsp, checklist, score: healthScore(checklist), next: tspNextStep(tsp, checklist), banks, documents, bankers, mid_quota: quota, history,
    pending_requests: pending.map((p) => ({ request_id: p.request_id, action: p.action, summary: p.payload?.summary ?? p.action, maker_email: p.maker_email, created_at: p.created_at })),
  };
}

const TSP_EDIT_COLS = ["name", "legal_name", "tsp_type", "gateway_code", "rbi_licence_no", "pci_dss_cert_no", "primary_contact_name",
  "primary_contact_email", "primary_contact_phone", "compliance_officer_name", "compliance_officer_email", "allowed_flows",
  "max_mids_per_banker", "max_bankers", "notes"] as const;

const tidy = (v: unknown) => (typeof v === "string" ? v.trim() || null : v);

export async function createTsp(i: TspInput, by: Maker): Promise<{ id: string }> {
  const p = tspInputProblem(i, true);
  if (p) throw new ChainError(400, "INVALID", p);
  const cols = ["code", "created_by"]; const args: unknown[] = [i.code, by.email];
  for (const k of TSP_EDIT_COLS) {
    if (i[k] === undefined) continue;
    cols.push(k); args.push(k === "allowed_flows" ? [...new Set(i.allowed_flows)] : tidy(i[k]));
  }
  const r = await rows<{ id: string }>("merchant", `
    INSERT INTO tsps (${cols.join(", ")}) VALUES (${cols.map((_, n) => `$${n + 1}`).join(", ")})
    ON CONFLICT (code) DO NOTHING RETURNING id::text
  `, args);
  if (!r.length) throw new ChainError(409, "CODE_TAKEN", `a TSP with code ${i.code} exists`);
  await audit(by, "tsp.created", "tsp", r[0].id, null, i);
  return r[0];
}

/**
 * Edit a TSP. A LIVE TSP's permissions (flows, quotas, type) change only through Maker-Checker:
 * the edit is saved as a request (`tsp.update_permissions`) and the rest applied at once.
 */
export async function updateTsp(id: string, i: TspInput, by: Maker): Promise<{ request_id?: string }> {
  const p = tspInputProblem(i, false);
  if (p) throw new ChainError(400, "INVALID", p);
  const t = await mustTsp(id);
  if (t.stage === "REJECTED") throw new ChainError(409, "TSP_REJECTED", "a rejected TSP cannot be edited");
  const locked: Record<string, unknown> = {};
  const sets: string[] = []; const args: unknown[] = [id];
  for (const k of TSP_EDIT_COLS) {
    if (i[k] === undefined) continue;
    const v = k === "allowed_flows" ? [...new Set(i.allowed_flows)] : tidy(i[k]);
    if ((t.stage === "LIVE" || t.stage === "SUSPENDED") && (TSP_LOCKED_WHEN_LIVE as readonly string[]).includes(k)) {
      if (JSON.stringify(v) !== JSON.stringify((t as any)[k])) locked[k] = v;
      continue;
    }
    args.push(v); sets.push(`${k} = $${args.length}`);
  }
  if (sets.length) {
    await rows("merchant", `UPDATE tsps SET ${sets.join(", ")}, updated_at = now() WHERE id = $1::uuid`, args);
    await audit(by, "tsp.updated", "tsp", id, null, Object.fromEntries(Object.entries(i).filter(([k]) => !(k in locked))));
  }
  if (Object.keys(locked).length) {
    const request_id = await requestApproval({
      resourceType: "tsp", resourceId: id, action: "tsp.update_permissions", maker: by,
      payload: { tsp_code: t.code, changes: locked, before: Object.fromEntries(Object.keys(locked).map((k) => [k, (t as any)[k]])) },
      summary: `Change ${t.code}'s ${Object.keys(locked).join(", ")}`,
    });
    return { request_id };
  }
  return {};
}

/**
 * The TSP's next onboarding step. Screening runs the sanctions / PEP check on its names; a
 * sanctions match refuses it unless a Super Admin overrides with a note. CONFIG → LIVE goes to
 * Maker-Checker (`tsp.go_live`).
 */
export async function advanceTsp(id: string, by: Maker & { persona: Persona }, opts: { notes?: string; override?: boolean } = {}):
  Promise<{ stage: string; request_id?: string; screening?: GateOutcome }> {
  const t = await mustTsp(id);
  let screening: GateOutcome | undefined;
  if (t.stage === "SCREENING") {
    screening = await screenNames([t.name, t.legal_name, t.compliance_officer_name, t.primary_contact_name]);
    const overriding = screening.result !== "PASS" && opts.override === true && by.persona === "SUPER_ADMIN";
    if (overriding && (opts.notes ?? "").trim().length < 5) throw new ChainError(400, "NOTE_REQUIRED", "an override needs a note saying why");
    const result = screening.result === "PASS" || overriding ? "CLEAR" : screening.result === "FAIL" ? "HIT" : "REVIEW";
    await rows("merchant", `UPDATE tsps SET screening_result = $2, screened_by = $3, screened_at = now(), updated_at = now() WHERE id = $1::uuid`,
      [id, result, by.email]);
    await audit(by, overriding ? "tsp.screening.override" : "tsp.screening", "tsp", id, null, { result: screening.result, summary: screening.summary, detail: screening.detail }, opts.notes);
    if (result !== "CLEAR")
      throw new ChainError(409, "SCREENING_NOT_CLEAR", screening.summary, { screening, can_override: by.persona === "SUPER_ADMIN" });
    t.screening_result = "CLEAR";
  }
  const facts = (await tspFactsMany([id])).get(id)!;
  const next = tspNextStep(t, tspChecklist(t, facts));
  if (!next.ok) throw new ChainError(409, next.code, next.message, { missing: next.missing });
  if (next.second_person) {
    const request_id = await requestApproval({
      resourceType: "tsp", resourceId: id, action: "tsp.go_live", maker: by, notes: opts.notes,
      payload: { tsp_code: t.code, from: t.stage }, summary: `Take TSP ${t.code} live`,
    });
    return { stage: t.stage, request_id, screening };
  }
  const r = await rows<{ stage: string }>("merchant", `
    UPDATE tsps SET stage = $3, updated_at = now() WHERE id = $1::uuid AND stage = $2 RETURNING stage`, [id, t.stage, next.to]);
  if (!r.length) throw new ChainError(409, "STAGE_CHANGED", "the TSP's stage changed meanwhile; reload");
  await audit(by, "tsp.advanced", "tsp", id, { stage: t.stage }, { stage: next.to }, opts.notes);
  return { stage: next.to, screening };
}

/** Suspend a LIVE TSP, or reactivate a SUSPENDED one: both through Maker-Checker. Reject one not yet live: at once. */
export async function tspStatusChange(id: string, action: "suspend" | "reactivate" | "reject", by: Maker, notes: string): Promise<{ stage: string; request_id?: string }> {
  const t = await mustTsp(id);
  if (notes.trim().length < 5) throw new ChainError(400, "NOTE_REQUIRED", "say why in a note");
  if (action === "reject") {
    const r = await rows<{ stage: string }>("merchant", `
      UPDATE tsps SET stage = 'REJECTED', updated_at = now() WHERE id = $1::uuid AND stage NOT IN ('LIVE','SUSPENDED','REJECTED') RETURNING stage`, [id]);
    if (!r.length) throw new ChainError(409, "CANNOT_REJECT", `a TSP in ${t.stage} cannot be rejected; suspend it instead`);
    await audit(by, "tsp.rejected", "tsp", id, { stage: t.stage }, { stage: "REJECTED" }, notes);
    return { stage: "REJECTED" };
  }
  const need = action === "suspend" ? "LIVE" : "SUSPENDED";
  if (t.stage !== need) throw new ChainError(409, "WRONG_STAGE", `only a ${need} TSP can be ${action === "suspend" ? "suspended" : "reactivated"}`);
  const request_id = await requestApproval({
    resourceType: "tsp", resourceId: id, action: `tsp.${action}`, maker: by, notes,
    payload: { tsp_code: t.code, reason: notes }, summary: `${action === "suspend" ? "Suspend" : "Reactivate"} TSP ${t.code}: ${notes}`,
  });
  return { stage: t.stage, request_id };
}

// TSP ↔ bank

export async function linkTspBank(tspId: string, bankId: string, by: Maker): Promise<void> {
  await mustTsp(tspId);
  const b = await rows<{ status: string }>("merchant", `SELECT status FROM banks WHERE id = $1::uuid`, [bankId]);
  if (!b.length) throw new ChainError(404, "NOT_FOUND", "bank not found");
  if (b[0].status !== "ACTIVE") throw new ChainError(409, "BANK_INACTIVE", "the bank is not active");
  const r = await rows("merchant", `
    INSERT INTO tsp_banks (tsp_id, bank_id, created_by) VALUES ($1::uuid, $2::uuid, $3)
    ON CONFLICT (tsp_id, bank_id) DO UPDATE SET status = 'PENDING', reference = NULL, confirmed_by = NULL, confirmed_at = NULL
      WHERE tsp_banks.status = 'ENDED'
    RETURNING 1`, [tspId, bankId, by.email]);
  if (!r.length) throw new ChainError(409, "ALREADY_LINKED", "the TSP is already linked to that bank");
  await audit(by, "tsp.bank.linked", "tsp", tspId, null, { bank_id: bankId });
}

/** The bank confirmed the TSP's authority to issue its MIDs (its letter or agreement reference). */
export async function confirmTspBank(tspId: string, bankId: string, reference: string, by: Maker): Promise<void> {
  if (reference.trim().length < 3) throw new ChainError(400, "REFERENCE_REQUIRED", "give the bank's letter or agreement reference");
  const r = await rows("merchant", `
    UPDATE tsp_banks SET status = 'CONFIRMED', reference = $3, confirmed_by = $4, confirmed_at = now()
     WHERE tsp_id = $1::uuid AND bank_id = $2::uuid AND status = 'PENDING' RETURNING 1`, [tspId, bankId, reference.trim(), by.email]);
  if (!r.length) throw new ChainError(409, "NOT_PENDING", "no pending link between that TSP and bank");
  await audit(by, "tsp.bank.confirmed", "tsp", tspId, null, { bank_id: bankId, reference: reference.trim() });
}

/** End a TSP's link to a bank. Refused while a banker is on that TSP with that issuing bank. */
export async function endTspBank(tspId: string, bankId: string, by: Maker, notes: string): Promise<void> {
  const used = await rows<{ n: number }>("merchant", `
    SELECT COUNT(*)::int AS n FROM merchants WHERE parent_tsp_id = $1::uuid AND issuing_bank_id = $2::uuid`, [tspId, bankId]);
  if (used[0].n > 0) throw new ChainError(409, "BANK_IN_USE", `${used[0].n} banker(s) are on this TSP with this bank`);
  const r = await rows("merchant", `
    UPDATE tsp_banks SET status = 'ENDED' WHERE tsp_id = $1::uuid AND bank_id = $2::uuid AND status <> 'ENDED' RETURNING 1`, [tspId, bankId]);
  if (!r.length) throw new ChainError(404, "NOT_FOUND", "no such link");
  await audit(by, "tsp.bank.ended", "tsp", tspId, null, { bank_id: bankId }, notes);
}

// TSP documents

export const TSP_DOC_STORE = process.env.KYB_STORE ?? "/opt/katana/kyb-store";

export async function addTspDocument(tspId: string, d: { doc_type: string; filename: string | null; content_type: string; size_bytes: number; sha256: string; storage_ref: string }, by: Maker): Promise<{ id: string }> {
  await mustTsp(tspId);
  if (!(TSP_DOC_TYPES as readonly string[]).includes(d.doc_type)) throw new ChainError(400, "INVALID", `doc_type must be one of ${TSP_DOC_TYPES.join(", ")}`);
  const r = await rows<{ id: string }>("merchant", `
    INSERT INTO tsp_documents (tsp_id, doc_type, filename, content_type, size_bytes, sha256, storage_ref, uploaded_by)
    VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8) RETURNING id::text`,
    [tspId, d.doc_type, d.filename, d.content_type, d.size_bytes, d.sha256, d.storage_ref, by.email]);
  await audit(by, "tsp.document.uploaded", "tsp", tspId, null, { doc_id: r[0].id, doc_type: d.doc_type, sha256: d.sha256 });
  return r[0];
}

/** Approve or reject an uploaded document. The uploader may not review their own upload. */
export async function reviewTspDocument(tspId: string, docId: string, decision: "APPROVED" | "REJECTED", note: string | null, by: Maker): Promise<void> {
  const d = await rows<{ uploaded_by: string | null; review: string }>("merchant", `
    SELECT uploaded_by, review FROM tsp_documents WHERE id = $1::uuid AND tsp_id = $2::uuid`, [docId, tspId]);
  if (!d.length) throw new ChainError(404, "NOT_FOUND", "document not found");
  if (d[0].uploaded_by && d[0].uploaded_by === by.email) throw new ChainError(403, "OWN_UPLOAD", "someone other than the uploader reviews a document");
  if (decision === "REJECTED" && (note ?? "").trim().length < 3) throw new ChainError(400, "NOTE_REQUIRED", "say why the document is rejected");
  const r = await rows("merchant", `
    UPDATE tsp_documents SET review = $3, reviewed_by = $4, reviewed_at = now(), review_note = $5
     WHERE id = $1::uuid AND tsp_id = $2::uuid AND review = 'PENDING' RETURNING 1`, [docId, tspId, decision, by.email, note?.trim() || null]);
  if (!r.length) throw new ChainError(409, "ALREADY_REVIEWED", `the document was already ${d[0].review}`);
  await audit(by, `tsp.document.${decision.toLowerCase()}`, "tsp", tspId, null, { doc_id: docId }, note ?? undefined);
}

export async function tspDocumentFile(tspId: string, docId: string): Promise<{ storage_ref: string; content_type: string; filename: string | null } | null> {
  return (await rows<{ storage_ref: string; content_type: string; filename: string | null }>("merchant", `
    SELECT storage_ref, content_type, filename FROM tsp_documents WHERE id = $1::uuid AND tsp_id = $2::uuid`, [docId, tspId]))[0] ?? null;
}

// ── A banker's chain and MIDs ───────────────────────────────────────────────────────────────

export interface IssuedMid {
  id: string; flow: Flow; mid_value: string; issued_on: string | null; expires_on: string | null;
  daily_limit: string | null; monthly_limit: string | null; currency: string; status: MidStatus;
  tsp_code: string; bank_code: string; request_id: string | null; requested_by: string; decided_by: string | null;
  decided_at: string | null; notes: string | null; created_at: string;
}

export interface BankerChain {
  banker: { id: string; merchant_code: string; stage: string; step_mid_issuance: boolean };
  tsp: { id: string; code: string; name: string; stage: string; allowed_flows: Flow[]; max_mids_per_banker: number | null } | null;
  bank: { id: string; code: string; name: string } | null;
  mids: IssuedMid[];
  events: { mid_id: string; from_status: string | null; to_status: string; actor: string | null; at: string }[];
  /** LIVE TSPs and the banks each is confirmed for: what the picker offers. */
  options: { id: string; code: string; name: string; allowed_flows: Flow[]; banks: { id: string; code: string; name: string }[] }[];
}

export async function bankerChain(merchantId: string): Promise<BankerChain> {
  const b = await rows<{ id: string; merchant_code: string; stage: string; step_mid_issuance: boolean; parent_tsp_id: string | null; issuing_bank_id: string | null }>("merchant", `
    SELECT id::text, merchant_code, stage, step_mid_issuance, parent_tsp_id::text, issuing_bank_id::text FROM merchants WHERE id = $1::uuid`, [merchantId]);
  if (!b.length) throw new ChainError(404, "NOT_FOUND", "banker not found");
  const m = b[0];
  const [tsp, bank, mids, events, opts] = await Promise.all([
    m.parent_tsp_id ? rows<NonNullable<BankerChain["tsp"]>>("merchant", `
      SELECT id::text, code, name, stage, allowed_flows, max_mids_per_banker FROM tsps WHERE id = $1::uuid`, [m.parent_tsp_id]) : Promise.resolve([]),
    m.issuing_bank_id ? rows<NonNullable<BankerChain["bank"]>>("merchant", `SELECT id::text, code, name FROM banks WHERE id = $1::uuid`, [m.issuing_bank_id]) : Promise.resolve([]),
    rows<IssuedMid>("merchant", `
      SELECT i.id::text, i.flow, i.mid_value, i.issued_on::text, i.expires_on::text, i.daily_limit::text, i.monthly_limit::text, i.currency, i.status,
             t.code AS tsp_code, b.code AS bank_code, i.request_id::text, i.requested_by, i.decided_by, i.decided_at, i.notes, i.created_at
        FROM issued_mids i JOIN tsps t ON t.id = i.tsp_id JOIN banks b ON b.id = i.bank_id
       WHERE i.merchant_id = $1::uuid
       ORDER BY CASE i.status WHEN 'ACTIVE' THEN 0 WHEN 'PENDING_APPROVAL' THEN 1 WHEN 'INACTIVE' THEN 2 ELSE 3 END, i.created_at DESC`, [merchantId]),
    rows<BankerChain["events"][number]>("merchant", `
      SELECT mid_id::text, from_status, to_status, actor, at FROM issued_mid_events e WHERE merchant_id = $1::uuid ORDER BY e.id DESC LIMIT 50`, [merchantId]),
    rows<{ id: string; code: string; name: string; allowed_flows: Flow[]; bank_id: string | null; bank_code: string | null; bank_name: string | null }>("merchant", `
      SELECT t.id::text, t.code, t.name, t.allowed_flows, b.id::text AS bank_id, b.code AS bank_code, b.name AS bank_name
        FROM tsps t
        LEFT JOIN tsp_banks tb ON tb.tsp_id = t.id AND tb.status = 'CONFIRMED'
        LEFT JOIN banks b ON b.id = tb.bank_id AND b.status = 'ACTIVE'
       WHERE t.stage = 'LIVE' ORDER BY t.code, b.code`),
  ]);
  const options = new Map<string, BankerChain["options"][number]>();
  for (const o of opts) {
    const e = options.get(o.id) ?? { id: o.id, code: o.code, name: o.name, allowed_flows: o.allowed_flows, banks: [] };
    if (o.bank_id) e.banks.push({ id: o.bank_id, code: o.bank_code!, name: o.bank_name! });
    options.set(o.id, e);
  }
  return {
    banker: { id: m.id, merchant_code: m.merchant_code, stage: m.stage, step_mid_issuance: m.step_mid_issuance },
    tsp: tsp[0] ?? null, bank: bank[0] ?? null, mids, events, options: [...options.values()],
  };
}

/** Put a banker on a LIVE TSP with an issuing bank the TSP is confirmed for. */
export async function setBankerChain(merchantId: string, tspId: string, bankId: string, by: Maker): Promise<void> {
  await tx(async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('tsp-bankers:' || $1))`, [tspId]);
    const m = (await c.query(`SELECT merchant_code, parent_tsp_id::text, issuing_bank_id::text FROM merchants WHERE id = $1::uuid FOR UPDATE`, [merchantId])).rows[0];
    if (!m) throw new ChainError(404, "NOT_FOUND", "banker not found");
    const tsp = (await c.query(`SELECT id::text, stage, max_bankers FROM tsps WHERE id = $1::uuid`, [tspId])).rows[0] ?? null;
    const bank = (await c.query(`SELECT status FROM banks WHERE id = $1::uuid`, [bankId])).rows[0];
    const link = (await c.query(`SELECT status FROM tsp_banks WHERE tsp_id = $1::uuid AND bank_id = $2::uuid`, [tspId, bankId])).rows[0];
    const others = (await c.query(`SELECT COUNT(*)::int AS n FROM merchants WHERE parent_tsp_id = $1::uuid AND id <> $2::uuid`, [tspId, merchantId])).rows[0].n;
    const elsewhere = (await c.query(`
      SELECT COUNT(*)::int AS n FROM issued_mids WHERE merchant_id = $1::uuid AND status IN ('ACTIVE','PENDING_APPROVAL') AND (tsp_id <> $2::uuid OR bank_id <> $3::uuid)`,
      [merchantId, tspId, bankId])).rows[0].n;
    const no = chainRefusal({
      tsp, bankLink: link?.status ?? null, bankActive: bank?.status === "ACTIVE",
      otherBankersOnTsp: others, midsOnOtherTsp: elsewhere,
    });
    // A banker already on this TSP is never refused by the TSP's banker cap.
    if (no && !(no.code === "TSP_BANKER_CAP" && m.parent_tsp_id === tspId)) refuse(no);
    await c.query(`UPDATE merchants SET parent_tsp_id = $2::uuid, issuing_bank_id = $3::uuid, updated_at = now() WHERE id = $1::uuid`, [merchantId, tspId, bankId]);
    await audit(by, "merchant.chain.set", "merchant", merchantId,
      { parent_tsp_id: m.parent_tsp_id, issuing_bank_id: m.issuing_bank_id }, { parent_tsp_id: tspId, issuing_bank_id: bankId });
  });
}

/** Record a MID the bank issued: saved PENDING_APPROVAL and sent to Maker-Checker (`mid.issue`). */
export async function requestMid(merchantId: string, i: MidInput, by: Maker): Promise<{ id: string; request_id: string }> {
  const p = midInputProblem(i);
  if (p) throw new ChainError(400, "INVALID", p);
  const flow = i.flow as Flow;
  const mid = await tx(async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('banker-mids:' || $1))`, [merchantId]);
    const m = (await c.query(`SELECT merchant_code, parent_tsp_id::text, issuing_bank_id::text FROM merchants WHERE id = $1::uuid`, [merchantId])).rows[0];
    if (!m) throw new ChainError(404, "NOT_FOUND", "banker not found");
    const tsp = m.parent_tsp_id ? (await c.query(`SELECT code, stage, allowed_flows, max_mids_per_banker FROM tsps WHERE id = $1::uuid`, [m.parent_tsp_id])).rows[0] ?? null : null;
    const link = m.parent_tsp_id && m.issuing_bank_id
      ? (await c.query(`SELECT status FROM tsp_banks WHERE tsp_id = $1::uuid AND bank_id = $2::uuid`, [m.parent_tsp_id, m.issuing_bank_id])).rows[0] : null;
    const open = (await c.query(`SELECT COUNT(*)::int AS n FROM issued_mids WHERE merchant_id = $1::uuid AND status IN ('ACTIVE','PENDING_APPROVAL')`, [merchantId])).rows[0].n;
    const no = midIssueRefusal({ banker: m, tsp, bankLink: link?.status ?? null, openMids: open }, flow);
    if (no) refuse(no);
    const r = await c.query(`
      INSERT INTO issued_mids (merchant_id, tsp_id, bank_id, flow, mid_value, issued_on, expires_on, daily_limit, monthly_limit, currency, requested_by, notes)
      VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (tsp_id, mid_value) WHERE status IN ('PENDING_APPROVAL','ACTIVE') DO NOTHING
      RETURNING id::text`,
      [merchantId, m.parent_tsp_id, m.issuing_bank_id, flow, i.mid_value!.trim(), i.issued_on || null, i.expires_on || null,
       i.daily_limit ?? null, i.monthly_limit ?? null, i.currency ?? "INR", by.email, i.notes?.trim() || null]);
    if (!r.rows.length) throw new ChainError(409, "MID_TAKEN", "that MID is already recorded on this TSP");
    return { id: r.rows[0].id as string, merchant_code: m.merchant_code as string, tsp_code: tsp.code as string, tsp_id: m.parent_tsp_id as string };
  });
  try {
    const request_id = await requestApproval({
      resourceType: "issued_mid", resourceId: mid.id, action: "mid.issue", maker: by, notes: i.notes ?? undefined,
      payload: { merchant_id: merchantId, merchant_code: mid.merchant_code, tsp_id: mid.tsp_id, tsp_code: mid.tsp_code, flow, mid_last4: i.mid_value!.trim().slice(-4) },
      summary: `Activate ${flow} MID …${i.mid_value!.trim().slice(-4)} for banker ${mid.merchant_code} (TSP ${mid.tsp_code})`,
    });
    await rows("merchant", `UPDATE issued_mids SET request_id = $2::uuid WHERE id = $1::uuid`, [mid.id, request_id]);
    return { id: mid.id, request_id };
  } catch (e) {
    // No request, no pending MID: it would wait for a checker who can never see it.
    await rows("merchant", `UPDATE issued_mids SET status = 'REJECTED', decided_by = 'system', decided_at = now(), notes = 'request could not be raised' WHERE id = $1::uuid`, [mid.id]).catch(() => {});
    throw e;
  }
}

async function midRow(midId: string, merchantId: string) {
  const r = await rows<{ id: string; status: MidStatus; flow: Flow; mid_value: string; request_id: string | null; requested_by: string; merchant_code: string; tsp_code: string; tsp_id: string }>("merchant", `
    SELECT i.id::text, i.status, i.flow, i.mid_value, i.request_id::text, i.requested_by, m.merchant_code, t.code AS tsp_code, t.id::text AS tsp_id
      FROM issued_mids i JOIN merchants m ON m.id = i.merchant_id JOIN tsps t ON t.id = i.tsp_id
     WHERE i.id = $1::uuid AND i.merchant_id = $2::uuid`, [midId, merchantId]);
  if (!r.length) throw new ChainError(404, "NOT_FOUND", "MID not found");
  return r[0];
}

/** Ask to take an ACTIVE MID out of use (`mid.deactivate`). */
export async function requestMidDeactivate(merchantId: string, midId: string, by: Maker, reason: string): Promise<{ request_id: string }> {
  if (reason.trim().length < 5) throw new ChainError(400, "NOTE_REQUIRED", "say why in a note");
  const m = await midRow(midId, merchantId);
  if (m.status !== "ACTIVE") throw new ChainError(409, "NOT_ACTIVE", `the MID is ${m.status}`);
  const request_id = await requestApproval({
    resourceType: "issued_mid", resourceId: midId, action: "mid.deactivate", maker: by, notes: reason,
    payload: { merchant_id: merchantId, merchant_code: m.merchant_code, tsp_id: m.tsp_id, tsp_code: m.tsp_code, flow: m.flow, mid_last4: m.mid_value.slice(-4), reason },
    summary: `Deactivate ${m.flow} MID …${m.mid_value.slice(-4)} of banker ${m.merchant_code}: ${reason}`,
  });
  return { request_id };
}

/** Withdraw a MID still waiting for approval (a typo, a wrong flow). */
export async function withdrawMid(merchantId: string, midId: string, by: Maker): Promise<void> {
  const m = await midRow(midId, merchantId);
  if (m.status !== "PENDING_APPROVAL") throw new ChainError(409, "NOT_PENDING", `the MID is ${m.status}`);
  const r = await rows("merchant", `
    UPDATE issued_mids SET status = 'REJECTED', decided_by = $2, decided_at = now(), notes = COALESCE(notes || ' · ', '') || 'withdrawn', updated_at = now()
     WHERE id = $1::uuid AND status = 'PENDING_APPROVAL' RETURNING 1`, [midId, by.email]);
  if (!r.length) throw new ChainError(409, "NOT_PENDING", "the MID was decided meanwhile");
  if (m.request_id) await withdrawRequest(m.request_id, by, "withdrawn by " + by.email);
  await audit(by, "mid.withdrawn", "issued_mid", midId, null, { merchant_id: merchantId });
}

/** What the MID_ISSUANCE gate needs to know about a banker. */
export async function midGateFacts(merchantId: string): Promise<{ hasTsp: boolean; hasBank: boolean; activeFlows: Flow[] }> {
  const m = await rows<{ parent_tsp_id: string | null; issuing_bank_id: string | null }>("merchant", `
    SELECT parent_tsp_id::text, issuing_bank_id::text FROM merchants WHERE id = $1::uuid`, [merchantId]);
  const f = await rows<{ flow: Flow }>("merchant", `SELECT DISTINCT flow FROM issued_mids WHERE merchant_id = $1::uuid AND status = 'ACTIVE'`, [merchantId]);
  return { hasTsp: !!m[0]?.parent_tsp_id, hasBank: !!m[0]?.issuing_bank_id, activeFlows: f.map((x) => x.flow) };
}

// ── What Maker-Checker approvals do (registered in lib/maker-checker-actions) ───────────────

export async function applyMidIssue(midId: string, checker: Maker): Promise<unknown> {
  return tx(async (c) => {
    const i = (await c.query(`SELECT merchant_id::text, tsp_id::text, bank_id::text, flow, status FROM issued_mids WHERE id = $1::uuid FOR UPDATE`, [midId])).rows[0];
    if (!i) throw new ChainError(404, "NOT_FOUND", "MID not found");
    if (i.status !== "PENDING_APPROVAL") throw new ChainError(409, "NOT_PENDING", `the MID is ${i.status}`);
    // Checked again: the TSP may have been suspended or its quota used since the MID was entered.
    const m = (await c.query(`SELECT parent_tsp_id::text, issuing_bank_id::text FROM merchants WHERE id = $1::uuid`, [i.merchant_id])).rows[0];
    if (m.parent_tsp_id !== i.tsp_id || m.issuing_bank_id !== i.bank_id)
      throw new ChainError(409, "CHAIN_CHANGED", "the banker's TSP or issuing bank changed since the MID was entered");
    const tsp = (await c.query(`SELECT stage, allowed_flows, max_mids_per_banker FROM tsps WHERE id = $1::uuid`, [i.tsp_id])).rows[0];
    const link = (await c.query(`SELECT status FROM tsp_banks WHERE tsp_id = $1::uuid AND bank_id = $2::uuid`, [i.tsp_id, i.bank_id])).rows[0];
    const active = (await c.query(`SELECT COUNT(*)::int AS n FROM issued_mids WHERE merchant_id = $1::uuid AND status = 'ACTIVE'`, [i.merchant_id])).rows[0].n;
    const no = midIssueRefusal({ banker: m, tsp, bankLink: link?.status ?? null, openMids: active }, i.flow);
    if (no) refuse(no);
    const r = (await c.query(`
      UPDATE issued_mids SET status = 'ACTIVE', decided_by = $2, decided_at = now(), updated_at = now()
       WHERE id = $1::uuid AND status = 'PENDING_APPROVAL' RETURNING id::text, flow, status`, [midId, checker.email])).rows[0];
    return r;
  });
}

export async function rejectMidIssue(midId: string, checker: Maker): Promise<void> {
  await rows("merchant", `
    UPDATE issued_mids SET status = 'REJECTED', decided_by = $2, decided_at = now(), updated_at = now()
     WHERE id = $1::uuid AND status = 'PENDING_APPROVAL'`, [midId, checker.email]);
}

export async function applyMidDeactivate(midId: string, checker: Maker): Promise<unknown> {
  const r = await rows("merchant", `
    UPDATE issued_mids SET status = 'INACTIVE', decided_by = $2, decided_at = now(), updated_at = now()
     WHERE id = $1::uuid AND status = 'ACTIVE' RETURNING id::text, flow, status`, [midId, checker.email]);
  if (!r.length) throw new ChainError(409, "NOT_ACTIVE", "the MID is no longer active");
  return r[0];
}

export async function applyTspStage(tspId: string, from: string, to: string, checker: Maker): Promise<unknown> {
  if (to === "LIVE" && from === "CONFIG") {
    // The checklist is checked again: something may have been undone since the request.
    const t = await mustTsp(tspId);
    const next = tspNextStep(t, tspChecklist(t, (await tspFactsMany([tspId])).get(tspId)!));
    if (!next.ok) throw new ChainError(409, next.code, next.message);
  }
  const r = await rows("merchant", `
    UPDATE tsps SET stage = $3, updated_at = now() WHERE id = $1::uuid AND stage = $2 RETURNING id::text, code, stage`, [tspId, from, to]);
  if (!r.length) throw new ChainError(409, "STAGE_CHANGED", `the TSP is no longer ${from}`);
  void checker;
  return r[0];
}

export async function applyTspPermissions(tspId: string, changes: Record<string, unknown>): Promise<unknown> {
  const p = tspInputProblem(changes as TspInput, false);
  if (p) throw new ChainError(400, "INVALID", p);
  const sets: string[] = []; const args: unknown[] = [tspId];
  for (const [k, v] of Object.entries(changes)) {
    if (!(TSP_LOCKED_WHEN_LIVE as readonly string[]).includes(k)) continue;
    args.push(v); sets.push(`${k} = $${args.length}`);
  }
  if (!sets.length) return null;
  return (await rows("merchant", `UPDATE tsps SET ${sets.join(", ")}, updated_at = now() WHERE id = $1::uuid RETURNING id::text, code, allowed_flows, max_mids_per_banker, max_bankers, tsp_type`, args))[0];
}
