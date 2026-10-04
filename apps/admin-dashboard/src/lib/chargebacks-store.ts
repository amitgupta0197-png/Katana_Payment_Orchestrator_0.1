// Banker-side chargebacks: intake, matching to the original pay-in, rule evaluation and the
// debit / reversal postings (vendorGateway 0039). The rules themselves are lib/chargeback-rules.
//
// Every write that moves money (a debit or a reversal) happens in one transaction with the state
// change, on a row locked FOR UPDATE, so two people pressing the same button post once.
// Postings and the state history are append-only in the database.

import type { PoolClient } from "pg";
import { db, rows } from "@/lib/pg";
import { branchKeysForMerchant, providerForMerchant } from "@/lib/provider-integration";
import {
  CB_OPEN, chainProblems, decideChargeback, pickCbRule, ruleDebit, stateAfterPostings,
  type CbRule, type CbSource, type CbState, type MatchedPayin, type ReversalKind,
} from "@/lib/chargeback-rules";

// ── Rules ───────────────────────────────────────────────────────────────────────────────────────

const RULE_COLS = `id::text, provider_id, banker_code, channel_type, reason_code, debit_bps, auto_debit,
  auto_max_amount::float AS auto_max_amount, version, effective_from, effective_to, note, created_by, created_at`;

export interface CbRuleRow extends CbRule { note: string | null; created_by: string | null; created_at: string }

export async function listCbRules(opts: { providerId?: string | null; includeEnded?: boolean } = {}): Promise<CbRuleRow[]> {
  const where: string[] = []; const args: unknown[] = [];
  if (opts.providerId !== undefined) { args.push(opts.providerId); where.push(`(provider_id IS NULL OR provider_id = $${args.length})`); }
  if (!opts.includeEnded) where.push(`(effective_to IS NULL OR effective_to > now())`);
  const r = await rows<CbRuleRow>("vendorGateway",
    `SELECT ${RULE_COLS} FROM payin_chargeback_rules ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY effective_from DESC LIMIT 500`, args);
  return r.map(normRule);
}

const normRule = (r: CbRuleRow): CbRuleRow => ({
  ...r,
  effective_from: new Date(r.effective_from).toISOString(),
  effective_to: r.effective_to ? new Date(r.effective_to).toISOString() : null,
});

export interface NewCbRule {
  provider_id: string | null; banker_code: string | null; channel_type: "INTENT" | "P2P" | null; reason_code: string | null;
  debit_bps: number; auto_debit: boolean; auto_max_amount: number | null; note: string;
}

/**
 * A rule is never edited: a new one for exactly the same scope ends the one in force and takes
 * the next version number. Chargebacks already decided keep the rule id and version they used.
 */
export async function createCbRule(r: NewCbRule, actor: string): Promise<CbRuleRow> {
  const c = await db("vendorGateway").connect();
  try {
    await c.query("BEGIN");
    const same = `provider_id IS NOT DISTINCT FROM $1 AND banker_code IS NOT DISTINCT FROM $2
                  AND channel_type IS NOT DISTINCT FROM $3 AND upper(COALESCE(reason_code,'')) = upper(COALESCE($4,''))`;
    const scope = [r.provider_id, r.banker_code, r.channel_type, r.reason_code];
    // Serialise rule changes for one scope.
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('cbrule:' || COALESCE($1,'') || '|' || COALESCE($2,'') || '|' || COALESCE($3,'') || '|' || upper(COALESCE($4,''))))`, scope);
    const prev = await c.query<{ version: number }>(
      `SELECT COALESCE(MAX(version), 0)::int AS version FROM payin_chargeback_rules WHERE ${same}`, scope);
    await c.query(`UPDATE payin_chargeback_rules SET effective_to = now()
                    WHERE ${same} AND (effective_to IS NULL OR effective_to > now())`, scope);
    const ins = await c.query<CbRuleRow>(`
      INSERT INTO payin_chargeback_rules
        (provider_id, banker_code, channel_type, reason_code, debit_bps, auto_debit, auto_max_amount, version, note, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${RULE_COLS}
    `, [...scope, r.debit_bps, r.auto_debit, r.auto_max_amount, (prev.rows[0]?.version ?? 0) + 1, r.note, actor]);
    await c.query("COMMIT");
    return normRule(ins.rows[0]);
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
}

/** End a rule without a replacement. Chargebacks it already decided keep it. */
export async function endCbRule(id: string): Promise<boolean> {
  const r = await rows<{ id: string }>("vendorGateway", `
    UPDATE payin_chargeback_rules SET effective_to = now()
     WHERE id = $1::uuid AND (effective_to IS NULL OR effective_to > now()) RETURNING id::text`, [id]);
  return r.length > 0;
}

// ── Chargebacks ─────────────────────────────────────────────────────────────────────────────────

export interface ChargebackInput {
  source: CbSource;
  source_name?: string | null;
  bank_ref: string;
  original_ref?: string | null;
  order_ref?: string | null;
  banker?: string | null;
  channel?: "INTENT" | "P2P" | null;
  amount: number;
  currency?: string;
  reason_code?: string | null;
  reason_text?: string | null;
  event_date?: string | null;
  livemode?: boolean;
}

export interface ChargebackRow {
  id: string; cb_ref: string; source: CbSource; source_name: string | null; bank_ref: string;
  original_ref: string | null; stated_order: string | null; stated_banker: string | null; stated_channel: string | null;
  amount: number; currency: string; reason_code: string | null; reason_text: string | null; event_date: string | null;
  livemode: boolean; received_at: string; received_by: string | null;
  order_id: string | null; order_ref: string | null; order_created_at: string | null; order_utr: string | null;
  merchant_id: string | null; provider_id: string | null; channel_type: string | null; order_amount: number | null;
  match_method: string | null; matched_at: string | null; matched_by: string | null;
  rule_id: string | null; rule_version: number | null; debit_bps: number | null; calculated_debit: number | null;
  debited: number; reversed: number; state: CbState; state_note: string | null; updated_at: string;
  override: boolean;
}

const CB_SELECT = `
  SELECT c.id::text, c.cb_ref, c.source, c.source_name, c.bank_ref, c.original_ref, c.stated_order, c.stated_banker,
         c.stated_channel, c.amount::float AS amount, c.currency, c.reason_code, c.reason_text,
         to_char(c.event_date, 'YYYY-MM-DD') AS event_date, c.livemode, c.received_at, c.received_by,
         c.order_id::text, o.order_id AS order_ref, o.created_at AS order_created_at,
         NULLIF(o.meta->'confirmation'->>'utr','') AS order_utr,
         c.merchant_id, c.provider_id, c.channel_type, c.order_amount::float AS order_amount,
         c.match_method, c.matched_at, c.matched_by, c.rule_id::text, c.rule_version, c.debit_bps,
         c.calculated_debit::float AS calculated_debit, c.debited::float AS debited, c.reversed::float AS reversed,
         c.state, c.state_note, c.updated_at,
         EXISTS (SELECT 1 FROM payin_chargeback_postings p
                  WHERE p.chargeback_id = c.id AND p.kind = 'CHARGEBACK_DEBIT' AND p.basis->>'method' = 'OVERRIDE') AS override
    FROM payin_chargebacks c
    LEFT JOIN vendor_payin_orders o ON o.id = c.order_id`;

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const norm = (r: ChargebackRow): ChargebackRow => ({
  ...r, received_at: iso(r.received_at)!, matched_at: iso(r.matched_at), updated_at: iso(r.updated_at)!,
  order_created_at: iso(r.order_created_at),
});

export async function getChargeback(id: string): Promise<ChargebackRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const r = await rows<ChargebackRow>("vendorGateway", `${CB_SELECT} WHERE c.id = $1::uuid`, [id]);
  return r[0] ? norm(r[0]) : null;
}

export interface CbListFilter {
  codes: string[] | null;        // bankers in scope; null = all (staff)
  channel?: string | null;
  state?: string | null;
  from?: string | null;          // YYYY-MM-DD, IST, on received_at
  to?: string | null;
  livemode: boolean;
  q?: string | null;             // a reference, order id or CB-…
  limit?: number;
}

function listWhere(f: CbListFilter): { where: string; args: unknown[] } {
  const w: string[] = []; const args: unknown[] = [];
  const add = (v: unknown) => { args.push(v); return `$${args.length}`; };
  w.push(`c.livemode = ${add(f.livemode)}`);
  if (f.codes) w.push(`c.merchant_id = ANY(${add(f.codes)}::text[])`);
  if (f.channel) w.push(`c.channel_type = ${add(f.channel)}`);
  if (f.state) w.push(`c.state = ${add(f.state)}`);
  if (f.from) w.push(`c.received_at >= (${add(f.from)}::date)::timestamp AT TIME ZONE 'Asia/Kolkata'`);
  if (f.to) w.push(`c.received_at < (${add(f.to)}::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'`);
  if (f.q) {
    const p = add(f.q.trim());
    w.push(`(c.cb_ref = ${p} OR c.bank_ref = ${p} OR c.original_ref = ${p} OR c.stated_order = ${p} OR o.order_id = ${p} OR o.vendor_txn_id = ${p})`);
  }
  return { where: `WHERE ${w.join(" AND ")}`, args };
}

export async function listChargebacks(f: CbListFilter): Promise<ChargebackRow[]> {
  if (f.codes && !f.codes.length) return [];
  const { where, args } = listWhere(f);
  const r = await rows<ChargebackRow>("vendorGateway",
    `${CB_SELECT} ${where} ORDER BY c.received_at DESC LIMIT ${Math.max(1, Math.min(f.limit ?? 200, 2000))}`, args);
  return r.map(norm);
}

export interface CbTotals {
  count: number; amount: number; debited: number; reversed: number; net_debited: number;
  pending_debit: number; open: number;
}
export const emptyCbTotals = (): CbTotals => ({ count: 0, amount: 0, debited: 0, reversed: 0, net_debited: 0, pending_debit: 0, open: 0 });

/** Totals per channel for the filter (state and q are ignored: the totals cover the window). */
export async function chargebackTotals(f: CbListFilter): Promise<Record<string, CbTotals>> {
  if (f.codes && !f.codes.length) return {};
  const { where, args } = listWhere({ ...f, state: null, q: null, channel: null });
  const r = await rows<{ channel: string; n: number; amount: number; debited: number; reversed: number; pending: number; open: number }>("vendorGateway", `
    SELECT COALESCE(c.channel_type, 'UNCLASSIFIED') AS channel, COUNT(*)::int AS n,
           COALESCE(SUM(c.amount) FILTER (WHERE c.state <> 'CB_DISMISSED'),0)::float AS amount,
           COALESCE(SUM(c.debited),0)::float AS debited, COALESCE(SUM(c.reversed),0)::float AS reversed,
           COALESCE(SUM(COALESCE(c.calculated_debit, c.amount)) FILTER (WHERE c.state = ANY($${args.length + 1}::text[])),0)::float AS pending,
           COUNT(*) FILTER (WHERE c.state = ANY($${args.length + 1}::text[]))::int AS open
      FROM payin_chargebacks c LEFT JOIN vendor_payin_orders o ON o.id = c.order_id
      ${where}
     GROUP BY 1
  `, [...args, CB_OPEN]);
  const out: Record<string, CbTotals> = {};
  for (const x of r) {
    out[x.channel] = {
      count: x.n, amount: x.amount, debited: x.debited, reversed: x.reversed,
      net_debited: Math.round((x.debited - x.reversed) * 100) / 100, pending_debit: x.pending, open: x.open,
    };
  }
  return out;
}

export interface CbPosting {
  id: string; kind: "CHARGEBACK_DEBIT" | "CHARGEBACK_REVERSAL"; amount: number; reverses_id: string | null;
  rule_id: string | null; rule_version: number | null; debit_bps: number | null; basis: Record<string, unknown>;
  actor: string; note: string | null; created_at: string;
}
export interface CbEvent { from_state: string | null; to_state: string; actor: string | null; note: string | null; at: string }

export async function chargebackChain(id: string): Promise<{ postings: CbPosting[]; events: CbEvent[] }> {
  const [postings, events] = await Promise.all([
    rows<CbPosting>("vendorGateway", `
      SELECT p.id::text, p.kind, p.amount::float AS amount, p.reverses_id::text, p.rule_id::text, p.rule_version, p.debit_bps, p.basis,
             p.actor, p.note, p.created_at FROM payin_chargeback_postings p WHERE p.chargeback_id = $1::uuid ORDER BY p.id`, [id]),
    rows<CbEvent>("vendorGateway", `
      SELECT from_state, to_state, actor, note, at FROM payin_chargeback_events WHERE chargeback_id = $1::uuid ORDER BY id`, [id]),
  ]);
  return {
    postings: postings.map((p) => ({ ...p, created_at: iso(p.created_at)! })),
    events: events.map((e) => ({ ...e, at: iso(e.at)! })),
  };
}

/** What is wrong with a chargeback's chain, in words; empty when it is reconciled. */
export function chargebackProblems(c: ChargebackRow, orderChannel?: string | null): string[] {
  return chainProblems({
    state: c.state, order_id: c.order_id, channel_type: c.channel_type, order_channel: orderChannel ?? c.channel_type,
    calculated_debit: c.calculated_debit, debited: c.debited, override: c.override,
  });
}

// ── Intake ──────────────────────────────────────────────────────────────────────────────────────

const newRef = () => `CB-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const clean = (v: string | null | undefined) => { const s = (v ?? "").trim(); return s ? s : null; };

/** The banker code a stated banker (code or uuid) means, or null when there is none. */
async function bankerCode(stated: string | null): Promise<string | null> {
  if (!stated) return null;
  const r = await rows<{ merchant_code: string }>("merchant",
    `SELECT merchant_code FROM merchants WHERE merchant_code = $1 OR id::text = $1 LIMIT 1`, [stated]).catch(() => []);
  return r[0]?.merchant_code ?? null;
}

/**
 * Record a chargeback as the banker side reported it, then try to match and rule on it. The same
 * (source, bank_ref) twice is the same chargeback: the second call returns the first.
 */
export async function ingestChargeback(input: ChargebackInput, actor: string): Promise<{ chargeback: ChargebackRow; created: boolean }> {
  const bankRef = input.bank_ref.trim();
  const existing = await rows<{ id: string }>("vendorGateway",
    `SELECT id::text FROM payin_chargebacks WHERE source = $1 AND bank_ref = $2`, [input.source, bankRef]);
  if (existing[0]) return { chargeback: (await getChargeback(existing[0].id))!, created: false };

  const statedBanker = clean(input.banker);
  const code = await bankerCode(statedBanker);
  const ins = await rows<{ id: string }>("vendorGateway", `
    INSERT INTO payin_chargebacks
      (cb_ref, source, source_name, bank_ref, original_ref, stated_order, stated_banker, stated_channel, amount, currency,
       reason_code, reason_text, event_date, livemode, received_by, merchant_id, state, state_note)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::date,$14,$15,$16,'CB_PENDING_MATCH','Received; matching to the original pay-in.')
    ON CONFLICT (source, bank_ref) DO NOTHING
    RETURNING id::text
  `, [newRef(), input.source, clean(input.source_name), bankRef, clean(input.original_ref), clean(input.order_ref),
      statedBanker, input.channel ?? null, Math.round(input.amount * 100) / 100, input.currency ?? "INR",
      clean(input.reason_code)?.toUpperCase() ?? null, clean(input.reason_text), clean(input.event_date),
      input.livemode !== false, actor, code]);
  if (!ins[0]) {   // lost a race with the same record
    const again = await rows<{ id: string }>("vendorGateway",
      `SELECT id::text FROM payin_chargebacks WHERE source = $1 AND bank_ref = $2`, [input.source, bankRef]);
    return { chargeback: (await getChargeback(again[0].id))!, created: false };
  }
  await evaluateChargeback(ins[0].id, actor);
  return { chargeback: (await getChargeback(ins[0].id))!, created: true };
}

interface Candidate extends MatchedPayin { livemode: boolean }

const CAND_COLS = `id::text, status, amount::float AS amount, channel_type, merchant_id, livemode`;

/**
 * The pay-ins a record can be about. An order id / KTN id the record carries is tried first, then
 * its reference (a UTR stated for the order, a bank credit matched to it, its RRN, or an order
 * id). Narrowed to the stated banker and the record's mode. Returned in two piles: the record's
 * own channel, and the other one (which it can never be matched to).
 */
async function candidatesFor(cb: { stated_order: string | null; original_ref: string | null; stated_banker: string | null;
  stated_channel: string | null; livemode: boolean; amount: number }): Promise<{ inChannel: Candidate[]; otherChannel: Candidate[]; method: "ORDER_ID" | "REFERENCE" }> {
  const keys = cb.stated_banker ? await branchKeysForMerchant(cb.stated_banker) : null;
  const scope = `vendor = 'KATANA' AND livemode = $2 AND ($3::text[] IS NULL OR merchant_id = ANY($3::text[]))`;
  let found: Candidate[] = [];
  let method: "ORDER_ID" | "REFERENCE" = "ORDER_ID";
  if (cb.stated_order) {
    found = await rows<Candidate>("vendorGateway", `
      SELECT ${CAND_COLS} FROM vendor_payin_orders
       WHERE ${scope} AND (order_id = $1 OR vendor_txn_id = $1 OR id::text = $1) LIMIT 10`, [cb.stated_order, cb.livemode, keys]);
  }
  if (!found.length && cb.original_ref) {
    method = "REFERENCE";
    found = await rows<Candidate>("vendorGateway", `
      SELECT ${CAND_COLS} FROM vendor_payin_orders
       WHERE ${scope} AND (
             meta->'confirmation'->>'utr' = $1 OR rrn = $1 OR order_id = $1 OR vendor_txn_id = $1
          OR id IN (SELECT matched_order_id FROM vendor_txn_alerts
                     WHERE utr = $1 AND outcome = 'CONFIRMED' AND matched_order_id IS NOT NULL))
       LIMIT 10`, [cb.original_ref, cb.livemode, keys]);
  }
  const inChannel = found.filter((o) => !cb.stated_channel || o.channel_type === cb.stated_channel);
  const otherChannel = found.filter((o) => cb.stated_channel && o.channel_type !== cb.stated_channel);
  // Several fit: the only one the chargeback can be for is one at least its amount.
  if (inChannel.length > 1) {
    const big = inChannel.filter((o) => o.amount + 0.005 >= cb.amount);
    if (big.length === 1) return { inChannel: big, otherChannel, method };
  }
  return { inChannel, otherChannel, method };
}

async function lockRow(c: PoolClient, id: string) {
  const r = await c.query(`SELECT id::text, state, amount::float AS amount, stated_order, original_ref, stated_banker, stated_channel,
                                  livemode, reason_code, order_id::text, debited::float AS debited, reversed::float AS reversed,
                                  merchant_id, provider_id, channel_type, rule_id::text, rule_version, debit_bps,
                                  calculated_debit::float AS calculated_debit
                             FROM payin_chargebacks WHERE id = $1::uuid FOR UPDATE`, [id]);
  return r.rows[0] as {
    id: string; state: CbState; amount: number; stated_order: string | null; original_ref: string | null;
    stated_banker: string | null; stated_channel: string | null; livemode: boolean; reason_code: string | null;
    order_id: string | null; debited: number; reversed: number; merchant_id: string | null; provider_id: string | null;
    channel_type: string | null; rule_id: string | null; rule_version: number | null; debit_bps: number | null;
    calculated_debit: number | null;
  } | undefined;
}

async function claimedByOthers(c: PoolClient, orderId: string, exceptId: string): Promise<number> {
  const r = await c.query(`SELECT COALESCE(SUM(amount),0)::float AS s FROM payin_chargebacks
                            WHERE order_id = $1::uuid AND id <> $2::uuid AND state NOT IN ('CB_DISMISSED','CB_REVERSED')`, [orderId, exceptId]);
  return Number(r.rows[0]?.s ?? 0);
}

async function post(c: PoolClient, p: {
  chargeback_id: string; order_id: string; merchant_id: string; provider_id: string | null; channel_type: string;
  kind: "CHARGEBACK_DEBIT" | "CHARGEBACK_REVERSAL"; amount: number; reverses_id?: string | null;
  rule_id?: string | null; rule_version?: number | null; debit_bps?: number | null; basis: Record<string, unknown>;
  actor: string; note?: string | null; livemode: boolean;
}) {
  await c.query(`
    INSERT INTO payin_chargeback_postings
      (chargeback_id, order_id, merchant_id, provider_id, channel_type, kind, amount, reverses_id,
       rule_id, rule_version, debit_bps, basis, actor, note, livemode)
    VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8::bigint,$9::uuid,$10,$11,$12::jsonb,$13,$14,$15)
  `, [p.chargeback_id, p.order_id, p.merchant_id, p.provider_id, p.channel_type, p.kind, p.amount, p.reverses_id ?? null,
      p.rule_id ?? null, p.rule_version ?? null, p.debit_bps ?? null, JSON.stringify(p.basis), p.actor, p.note ?? null, p.livemode]);
}

export class ChargebackError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

/**
 * Match a chargeback to its pay-in (or to `manualOrderId`, chosen by a person), pick the rule and
 * apply the decision, posting the debit when the rule allows it. Only a chargeback that is still
 * open is evaluated; one already decided is left alone.
 */
export async function evaluateChargeback(id: string, actor: string, manualOrderId?: string): Promise<ChargebackRow | null> {
  // Read outside the transaction: the candidates and rules come from other tables and databases.
  const pre = await getChargeback(id);
  if (!pre) return null;
  if (!CB_OPEN.includes(pre.state)) {
    if (manualOrderId) throw new ChargebackError(409, "ALREADY_DECIDED", "This chargeback is already decided; reverse or dismiss it instead.");
    return pre;
  }

  let order: Candidate | null = null;
  let candidates = 0;
  let crossNote: string | null = null;
  let method: "ORDER_ID" | "REFERENCE" | "MANUAL" = "MANUAL";
  if (manualOrderId) {
    const r = await rows<Candidate>("vendorGateway",
      `SELECT ${CAND_COLS} FROM vendor_payin_orders WHERE vendor = 'KATANA' AND (id::text = $1 OR order_id = $1 OR vendor_txn_id = $1)
         AND ($2::text IS NULL OR merchant_id = ANY($3::text[]))`,
      [manualOrderId, pre.stated_banker, pre.stated_banker ? await branchKeysForMerchant(pre.stated_banker) : null]);
    if (r.length !== 1) throw new ChargebackError(404, "ORDER_NOT_FOUND", r.length ? "That reference is on more than one pay-in; use the Katana order id." : "No pay-in has that reference.");
    if (r[0].livemode !== pre.livemode) throw new ChargebackError(422, "MODE_MISMATCH", "The chargeback and the pay-in are not in the same mode (test / live).");
    if (pre.stated_channel && r[0].channel_type !== pre.stated_channel) {
      throw new ChargebackError(422, "CROSS_CHANNEL", `The record is for ${pre.stated_channel} and that pay-in is ${r[0].channel_type}. A chargeback is never matched across channels.`);
    }
    order = r[0]; candidates = 1;
  } else {
    const c = await candidatesFor({ ...pre });
    candidates = c.inChannel.length;
    method = c.method;
    if (c.inChannel.length === 1) order = c.inChannel[0];
    else if (!c.inChannel.length && c.otherChannel.length) {
      crossNote = `A ${c.otherChannel[0].channel_type} pay-in has this reference, but the record is for ${pre.stated_channel}. Not matched across channels.`;
    }
  }

  const banker = order?.merchant_id ? (await bankerCode(order.merchant_id)) ?? order.merchant_id : null;
  const providerId = banker ? await providerForMerchant(banker) : null;
  const rules = order ? await listCbRules({}) : [];
  const rule = order ? pickCbRule(rules, {
    providerId, banker, channel: order.channel_type, reasonCode: pre.reason_code, at: new Date(),
  }) : null;

  const c = await db("vendorGateway").connect();
  try {
    await c.query("BEGIN");
    const row = await lockRow(c, id);
    if (!row || !CB_OPEN.includes(row.state)) { await c.query("ROLLBACK"); return getChargeback(id); }
    const claimed = order ? await claimedByOthers(c, order.id, id) : 0;
    const d = decideChargeback({ amount: row.amount, order, candidates, alreadyClaimed: claimed, rule });
    const note = crossNote && d.state === "CB_PENDING_MATCH" ? crossNote : d.note;
    const state = crossNote && d.state === "CB_PENDING_MATCH" ? "CB_MANUAL_REVIEW" : d.state;
    const calc = rule && order ? ruleDebit(row.amount, rule) : null;

    await c.query(`
      UPDATE payin_chargebacks SET
        order_id = $2::uuid, merchant_id = COALESCE($3, merchant_id), provider_id = $4, channel_type = $5, order_amount = $6,
        match_method = $7, matched_at = CASE WHEN $2::uuid IS NULL THEN NULL ELSE COALESCE(matched_at, now()) END,
        matched_by = CASE WHEN $2::uuid IS NULL THEN NULL ELSE $8 END,
        rule_id = $9::uuid, rule_version = $10, debit_bps = $11, calculated_debit = $12,
        state = $13, state_note = $14, updated_by = $8, updated_at = now()
      WHERE id = $1::uuid
    `, [id, order?.id ?? null, banker, providerId, order?.channel_type ?? null, order?.amount ?? null,
        order ? method : null, actor,
        rule?.id ?? null, rule?.version ?? null, rule?.debit_bps ?? null, calc, state, note]);

    if ((d.state === "CB_DEBIT_POSTED" || d.state === "CB_PARTIAL_DEBIT") && order && banker && rule) {
      await post(c, {
        chargeback_id: id, order_id: order.id, merchant_id: banker, provider_id: providerId, channel_type: order.channel_type,
        kind: "CHARGEBACK_DEBIT", amount: d.debit, rule_id: rule.id, rule_version: rule.version, debit_bps: rule.debit_bps,
        basis: { method: "RULE", chargeback_amount: row.amount, debit_bps: rule.debit_bps, rule_id: rule.id, rule_version: rule.version,
                 order_amount: order.amount, calculated: d.debit },
        actor, livemode: row.livemode,
      });
      await c.query(`UPDATE payin_chargebacks SET debited = debited + $2 WHERE id = $1::uuid`, [id, d.debit]);
    }
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
  return getChargeback(id);
}

/**
 * A person decides a chargeback in review (or with no rule). Without `amount` the rule in force is
 * applied; with one, that amount is posted as a person's override and recorded as such. 0 means
 * "no debit". The pay-in must be matched first.
 */
export async function approveChargeback(id: string, actor: string, opts: { amount?: number | null; note: string }): Promise<ChargebackRow | null> {
  const pre = await getChargeback(id);
  if (!pre) return null;
  if (!CB_OPEN.includes(pre.state)) throw new ChargebackError(409, "ALREADY_DECIDED", "This chargeback is already decided.");
  if (!pre.order_id || !pre.merchant_id || !pre.channel_type) throw new ChargebackError(422, "NOT_MATCHED", "Match the chargeback to its pay-in first.");

  let amount: number; let rule: CbRule | null = null;
  if (opts.amount == null) {
    rule = pickCbRule(await listCbRules({}), {
      providerId: pre.provider_id, banker: pre.merchant_id, channel: pre.channel_type, reasonCode: pre.reason_code, at: new Date(),
    });
    if (!rule) throw new ChargebackError(422, "NO_RULE", "No chargeback rule applies. Set one, or state the amount to debit.");
    amount = ruleDebit(pre.amount, rule);
  } else {
    amount = Math.round(opts.amount * 100) / 100;
  }
  if (amount < 0 || amount > pre.amount + 0.005) throw new ChargebackError(422, "BAD_AMOUNT", "The debit must be between 0 and the chargeback amount.");

  const c = await db("vendorGateway").connect();
  try {
    await c.query("BEGIN");
    const row = await lockRow(c, id);
    if (!row || !CB_OPEN.includes(row.state)) { await c.query("ROLLBACK"); throw new ChargebackError(409, "ALREADY_DECIDED", "This chargeback was decided a moment ago."); }
    if (amount > 0) {
      await post(c, {
        chargeback_id: id, order_id: row.order_id!, merchant_id: row.merchant_id!, provider_id: row.provider_id,
        channel_type: row.channel_type!, kind: "CHARGEBACK_DEBIT", amount,
        rule_id: rule?.id ?? null, rule_version: rule?.version ?? null, debit_bps: rule?.debit_bps ?? null,
        basis: rule
          ? { method: "RULE", chargeback_amount: row.amount, debit_bps: rule.debit_bps, rule_id: rule.id, rule_version: rule.version, calculated: amount, approved_by: actor }
          : { method: "OVERRIDE", chargeback_amount: row.amount, stated_amount: amount, approved_by: actor },
        actor, note: opts.note, livemode: row.livemode,
      });
    }
    const state: CbState = amount > 0 ? stateAfterPostings(row.amount, amount, 0) : "CB_MATCHED";
    await c.query(`
      UPDATE payin_chargebacks SET debited = debited + $2, state = $3, state_note = $4, updated_by = $5, updated_at = now(),
             rule_id = COALESCE($6::uuid, rule_id), rule_version = COALESCE($7, rule_version), debit_bps = COALESCE($8, debit_bps),
             calculated_debit = CASE WHEN $6::uuid IS NULL THEN calculated_debit ELSE $2 END
       WHERE id = $1::uuid
    `, [id, amount, state, `${amount > 0 ? `Debit of ₹${amount.toFixed(2)} approved` : "No debit"} by a person: ${opts.note}`, actor,
        rule?.id ?? null, rule?.version ?? null, rule?.debit_bps ?? null]);
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
  return getChargeback(id);
}

/** A debit given back: a new reversal entry linked to the latest debit. Never an edit of the debit. */
export async function reverseChargeback(id: string, actor: string, opts: { kind: ReversalKind; amount?: number | null; note: string }): Promise<ChargebackRow | null> {
  const c = await db("vendorGateway").connect();
  try {
    await c.query("BEGIN");
    const row = await lockRow(c, id);
    if (!row) { await c.query("ROLLBACK"); return null; }
    const open = Math.round((row.debited - row.reversed) * 100) / 100;
    if (open <= 0) throw new ChargebackError(409, "NOTHING_TO_REVERSE", "Nothing has been debited on this chargeback, or all of it is already reversed.");
    const amount = opts.amount == null ? open : Math.round(opts.amount * 100) / 100;
    if (amount <= 0 || amount > open + 0.005) throw new ChargebackError(422, "BAD_AMOUNT", `A reversal must be between ₹0.01 and ₹${open.toFixed(2)}.`);
    const last = await c.query<{ id: string }>(`SELECT id::text FROM payin_chargeback_postings
      WHERE chargeback_id = $1::uuid AND kind = 'CHARGEBACK_DEBIT' ORDER BY id DESC LIMIT 1`, [id]);
    await post(c, {
      chargeback_id: id, order_id: row.order_id!, merchant_id: row.merchant_id!, provider_id: row.provider_id,
      channel_type: row.channel_type!, kind: "CHARGEBACK_REVERSAL", amount, reverses_id: last.rows[0]?.id ?? null,
      basis: { method: opts.kind, debited: row.debited, reversed_before: row.reversed, amount },
      actor, note: opts.note, livemode: row.livemode,
    });
    const state = stateAfterPostings(row.amount, row.debited, row.reversed + amount);
    await c.query(`UPDATE payin_chargebacks SET reversed = reversed + $2, state = $3, state_note = $4, updated_by = $5, updated_at = now()
                    WHERE id = $1::uuid`,
      [id, amount, state, `₹${amount.toFixed(2)} reversed (${opts.kind.toLowerCase().replace(/_/g, " ")}): ${opts.note}`, actor]);
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
  return getChargeback(id);
}

/** Close a record that is not a real chargeback against Katana. Only while nothing is debited. */
export async function dismissChargeback(id: string, actor: string, note: string): Promise<ChargebackRow | null> {
  const r = await rows<{ id: string }>("vendorGateway", `
    UPDATE payin_chargebacks SET state = 'CB_DISMISSED', state_note = $2, updated_by = $3, updated_at = now()
     WHERE id = $1::uuid AND debited = 0 AND state <> 'CB_DISMISSED' RETURNING id::text`, [id, `Dismissed: ${note}`, actor]);
  if (!r.length) {
    const cur = await getChargeback(id);
    if (!cur) return null;
    throw new ChargebackError(409, "CANNOT_DISMISS", cur.debited > 0 ? "A debit was posted; reverse it instead." : "Already dismissed.");
  }
  return getChargeback(id);
}
