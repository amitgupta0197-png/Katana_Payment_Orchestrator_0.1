// Settlement Engine, phase 1 — storage and the moves (rules in lib/settlement-engine).
//
// Where things live:
//   settlementservice_db  settlement_configs, settlement_controls, settlement_instructions (+ events,
//                         trigger-written), settlement_reserve_holds          (settlement 0002)
//   ledgerservice_db      every amount, as journals (ledger 0004)
//   providerservice_db    the banker→merchant settlement request each instruction raises
//                         (provider_branch_settlements.instruction_id, provider 0021)
//
// An instruction is raised under a per-banker advisory lock held across reading the balance,
// writing the instruction and posting its journal, so two runs can never raise against the same
// payable. Every journal has an idempotency key derived from the instruction (settle:<id>:<step>),
// and every state move is a guarded UPDATE (… AND state = <from>), so a repeated or raced move
// changes nothing twice. After INITIATED the engine follows the request's status: the banker pays
// and enters the UTR, the merchant verifies, in the screens they already use.

import type { PoolClient } from "pg";
import { db, rows } from "@/lib/pg";
import { postJournal, accountBalance } from "@/lib/ledger";
import { resolveRule } from "@/lib/settlement-rules";
import { providerForMerchant } from "@/lib/provider-integration";
import { purposeForAmount } from "@/lib/branch-settlement";
import {
  acct, canMove, configProblem, cycleGross, dueCycle, initiatedLines, isFinal, reserveReleaseLines, reversed, settledLines,
  settlementAmounts, stateForBranchStatus, NO_RATE_CARD,
  type Cycle, type InstructionState, type RateCard, type SettlementAmounts, type SettlementConfigBody,
} from "@/lib/settlement-engine";

// ── Configs (versioned, two-person) ─────────────────────────────────────────────────────────

export interface ConfigRow {
  id: string; banker_code: string; provider_id: string | null; version: number;
  state: "DRAFT" | "PENDING_APPROVAL" | "ACTIVE" | "SUPERSEDED" | "REJECTED";
  body: SettlementConfigBody; maker: string; maker_note: string | null; checker: string | null; checker_note: string | null;
  created_at: string; decided_at: string | null; effective_from: string | null;
}
const CONFIG_COLS = `id::text, banker_code, provider_id::text, version, state, body, maker, maker_note, checker, checker_note, created_at, decided_at, effective_from`;

export class SettlementError extends Error {
  constructor(message: string, readonly code: string, readonly status = 409) { super(message); }
}

export async function activeConfig(banker: string): Promise<ConfigRow | null> {
  return (await rows<ConfigRow>("settlement", `SELECT ${CONFIG_COLS} FROM settlement_configs WHERE banker_code = $1 AND state = 'ACTIVE'`, [banker]))[0] ?? null;
}
export async function configHistory(banker: string): Promise<ConfigRow[]> {
  return rows<ConfigRow>("settlement", `SELECT ${CONFIG_COLS} FROM settlement_configs WHERE banker_code = $1 ORDER BY version DESC`, [banker]);
}

/** A new version, waiting for a second person. One may wait at a time per banker. */
export async function proposeConfig(banker: string, body: SettlementConfigBody, maker: string, note: string | null): Promise<ConfigRow> {
  const why = configProblem(body);
  if (why) throw new SettlementError(why, "CONFIG_INVALID", 400);
  const providerId = await providerForMerchant(banker);
  if (body.beneficiary_id) {
    const ok = await rows("provider", `SELECT 1 FROM provider_beneficiary_accounts WHERE id = $1::uuid AND provider_id = $2::uuid AND active`, [body.beneficiary_id, providerId]).catch(() => []);
    if (!ok.length) throw new SettlementError("the beneficiary account is not an active account of this banker's merchant", "BENEFICIARY_INVALID", 400);
  }
  try {
    return (await rows<ConfigRow>("settlement", `
      INSERT INTO settlement_configs (banker_code, provider_id, version, state, body, maker, maker_note)
      VALUES ($1, $2::uuid, COALESCE((SELECT max(version) FROM settlement_configs WHERE banker_code = $1), 0) + 1, 'PENDING_APPROVAL', $3::jsonb, $4, $5)
      RETURNING ${CONFIG_COLS}
    `, [banker, providerId, JSON.stringify(body), maker, note]))[0];
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new SettlementError("a change is already waiting for approval for this banker", "CONFIG_PENDING");
    throw e;
  }
}

/** Approve (it becomes ACTIVE, the previous version SUPERSEDED) or reject. Never by its maker. */
export async function decideConfig(id: string, checker: string, approve: boolean, note: string | null): Promise<ConfigRow> {
  const c = await db("settlement").connect();
  try {
    await c.query("BEGIN");
    const cur = (await c.query<ConfigRow>(`SELECT ${CONFIG_COLS} FROM settlement_configs WHERE id = $1::uuid FOR UPDATE`, [id])).rows[0];
    if (!cur) throw new SettlementError("no such config", "NOT_FOUND", 404);
    if (cur.state !== "PENDING_APPROVAL") throw new SettlementError(`this version is ${cur.state.toLowerCase()}, not waiting for approval`, "CONFIG_NOT_PENDING");
    if (cur.maker === checker) throw new SettlementError("the person who made a change cannot approve it", "SELF_APPROVAL", 403);
    if (approve) await c.query(`UPDATE settlement_configs SET state = 'SUPERSEDED' WHERE banker_code = $1 AND state = 'ACTIVE'`, [cur.banker_code]);
    const out = (await c.query<ConfigRow>(`
      UPDATE settlement_configs SET state = $2, checker = $3, checker_note = $4, decided_at = now(),
             effective_from = CASE WHEN $2 = 'ACTIVE' THEN now() END
       WHERE id = $1::uuid RETURNING ${CONFIG_COLS}`, [id, approve ? "ACTIVE" : "REJECTED", checker, note])).rows[0];
    await c.query("COMMIT");
    return out;
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
}

export async function setPaused(banker: string, paused: boolean, reason: string | null, by: string): Promise<void> {
  await rows("settlement", `
    INSERT INTO settlement_controls (banker_code, paused, reason, set_by, set_at) VALUES ($1, $2, $3, $4, now())
    ON CONFLICT (banker_code) DO UPDATE SET paused = EXCLUDED.paused, reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, set_at = now()
  `, [banker, paused, reason, by]);
}
export async function isPaused(banker: string): Promise<boolean> {
  return !!(await rows<{ paused: boolean }>("settlement", `SELECT paused FROM settlement_controls WHERE banker_code = $1`, [banker]))[0]?.paused;
}

// ── Balances (from the ledger) ──────────────────────────────────────────────────────────────

export interface BankerBalances { payable: bigint; reserve: bigint; in_transit: bigint; held_by_banker: bigint }

/** Liability balances are credit-normal: the ledger's debit-positive figure, negated. */
export async function bankerBalances(banker: string): Promise<BankerBalances> {
  const [p, r, t, h] = await Promise.all([
    accountBalance(acct.payable(banker)), accountBalance(acct.reserve(banker)),
    accountBalance(acct.transit(banker)), accountBalance(acct.held(banker)),
  ]);
  return { payable: -p, reserve: -r, in_transit: -t, held_by_banker: h };
}

/** Collections credited to the banker's payable with a value date at or after `cutoff`. */
async function paidSince(banker: string, cutoff: Date): Promise<bigint> {
  const r = await rows<{ s: string }>("ledger", `
    SELECT COALESCE(SUM(l.amount_minor), 0)::text AS s
      FROM ledger_lines l JOIN journal_entries j ON j.id = l.journal_id JOIN accounts a ON a.id = l.account_id
     WHERE a.code = $1 AND a.currency = 'INR' AND l.side = 'C' AND j.journal_type = 'payin.collected'
       AND COALESCE(j.value_at, j.posted_at) >= $2
  `, [acct.payable(banker), cutoff.toISOString()]);
  return BigInt(r[0]?.s ?? "0");
}

/** The banker's merchant's rate card (provider_settlement_rules), in paise. */
async function rateCardFor(banker: string, providerId: string | null): Promise<RateCard> {
  if (!providerId) return NO_RATE_CARD;
  const r = await resolveRule(providerId, banker);
  if (!r.id) return NO_RATE_CARD;
  const p = (x: number | null) => (x == null ? null : Math.round(x * 100));
  return {
    id: r.id, version: r.version, upline_bps: r.upline_bps, katana_bps: r.katana_bps, downline_bps: r.downline_bps,
    gst_bps: r.gst_bps, fixed_fee_minor: p(r.fixed_fee) ?? 0, min_charge_minor: p(r.min_charge), max_charge_minor: p(r.max_charge),
  };
}

// ── Instructions ────────────────────────────────────────────────────────────────────────────

export interface InstructionRow {
  id: string; idempotency_key: string; banker_code: string; provider_id: string | null;
  kind: "SCHEDULED" | "ON_DEMAND" | "MANUAL"; cycle_key: string | null; cutoff_at: string | null;
  config_id: string | null; config_version: number | null; currency: string;
  gross_minor: string; reserve_minor: string; upline_minor: string; katana_minor: string; downline_minor: string;
  fixed_minor: string; gst_minor: string; tds_minor: string; net_minor: string;
  rule_id: string | null; rule_version: number | null; beneficiary_id: string | null; transfer_mode: string | null;
  state: InstructionState; held_from: InstructionState | null; branch_settlement_id: string | null; utr: string | null;
  reason: string | null; created_by: string; created_at: string; updated_at: string;
}
const INSTR_COLS = `id::text, idempotency_key, banker_code, provider_id::text, kind, cycle_key, cutoff_at, config_id::text, config_version, currency,
  gross_minor::text, reserve_minor::text, upline_minor::text, katana_minor::text, downline_minor::text, fixed_minor::text,
  gst_minor::text, tds_minor::text, net_minor::text, rule_id::text, rule_version, beneficiary_id::text, transfer_mode,
  state, held_from, branch_settlement_id::text, utr, reason, created_by, created_at, updated_at`;

export async function getInstruction(id: string): Promise<InstructionRow | null> {
  return (await rows<InstructionRow>("settlement", `SELECT ${INSTR_COLS} FROM settlement_instructions WHERE id = $1::uuid`, [id]))[0] ?? null;
}

const amountsOf = (i: InstructionRow): SettlementAmounts => ({
  gross: BigInt(i.gross_minor), reserve: BigInt(i.reserve_minor), upline: BigInt(i.upline_minor), katana: BigInt(i.katana_minor),
  downline: BigInt(i.downline_minor), fixed: BigInt(i.fixed_minor),
  charges: BigInt(i.upline_minor) + BigInt(i.katana_minor) + BigInt(i.downline_minor) + BigInt(i.fixed_minor),
  gst: BigInt(i.gst_minor), tds: BigInt(i.tds_minor), net: BigInt(i.net_minor),
});
const rupees = (paise: bigint) => (Number(paise) / 100).toFixed(2);

/** A guarded state move: only from `from`, with the actor and reason in the trigger-written event. */
async function move(id: string, from: InstructionState, to: InstructionState, actor: string, reason: string | null,
  set: Record<string, unknown> = {}): Promise<boolean> {
  const c = await db("settlement").connect();
  try {
    await c.query("BEGIN");
    await c.query(`SELECT set_config('settlement.actor', $1, true), set_config('settlement.reason', $2, true)`, [actor, reason ?? ""]);
    const keys = Object.keys(set);
    const extra = keys.map((k, i) => `, ${k} = $${i + 4}`).join("");
    const r = await c.query(`UPDATE settlement_instructions SET state = $3, updated_at = now()${extra}
       WHERE id = $1::uuid AND state = $2 RETURNING id`, [id, from, to, ...keys.map((k) => set[k])]);
    await c.query("COMMIT");
    return (r.rowCount ?? 0) > 0;
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
}

async function withBankerLock<T>(banker: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db("settlement").connect();
  try {
    await c.query("SELECT pg_advisory_lock(hashtext($1))", [`settle:${banker}`]);
    try { return await fn(c); } finally { await c.query("SELECT pg_advisory_unlock(hashtext($1))", [`settle:${banker}`]).catch(() => {}); }
  } finally { c.release(); }
}

export interface RaiseInput {
  banker: string;
  kind: "SCHEDULED" | "ON_DEMAND" | "MANUAL";
  cycle?: Cycle | null;
  /** ON_DEMAND / MANUAL: the gross asked for (paise); never more than the available balance. */
  amount_minor?: bigint | null;
  actor: string;
  /** MANUAL: the caller's own idempotency key (a retried request raises once). */
  key?: string | null;
}

/**
 * Raise one settlement: decide the gross, write the instruction, post the INITIATED journal, raise
 * the banker→merchant request and record the reserve hold. Null = nothing to settle this cycle.
 */
export async function raiseInstruction(input: RaiseInput): Promise<InstructionRow | null> {
  const cfgRow = await activeConfig(input.banker);
  if (!cfgRow) throw new SettlementError("this banker has no approved settlement config", "NO_CONFIG");
  const cfg = cfgRow.body;
  if (!cfg.beneficiary_id) throw new SettlementError("the settlement config names no beneficiary account", "NO_BENEFICIARY");
  if (await isPaused(input.banker)) throw new SettlementError("settlement is paused for this banker", "PAUSED");
  if (input.kind === "ON_DEMAND" && !(cfg.allow_on_demand || cfg.timing === "ON_DEMAND"))
    throw new SettlementError("on-demand payouts are not enabled for this banker", "ON_DEMAND_NOT_ENABLED", 422);

  const key = input.kind === "SCHEDULED" ? `cycle:${input.banker}:${input.cycle!.key}`
    : input.key ? `${input.kind.toLowerCase()}:${input.banker}:${input.key}` : null;
  if (!key) throw new SettlementError("an idempotency key is required", "IDEMPOTENCY_KEY_REQUIRED", 400);

  const created = await withBankerLock(input.banker, async () => {
    const prior = (await rows<InstructionRow>("settlement", `SELECT ${INSTR_COLS} FROM settlement_instructions WHERE idempotency_key = $1`, [key]))[0];
    if (prior) return prior;

    const bal = await bankerBalances(input.banker);
    let gross: bigint;
    if (input.kind === "SCHEDULED") {
      gross = cycleGross(bal.payable, await paidSince(input.banker, input.cycle!.cutoff), cfg);
      if (gross === 0n) return null;
    } else {
      const available = cycleGross(bal.payable, 0n, { min_payout_minor: 0, max_payout_minor: cfg.max_payout_minor });
      gross = input.amount_minor ?? available;
      if (gross <= 0n) throw new SettlementError("nothing is available to settle", "NOTHING_AVAILABLE", 422);
      if (gross > available) throw new SettlementError(`only ${rupees(available)} is available to settle`, "INSUFFICIENT_BALANCE", 409);
      if (gross < BigInt(cfg.min_payout_minor)) throw new SettlementError(`below the minimum payout of ${rupees(BigInt(cfg.min_payout_minor))}`, "BELOW_MINIMUM", 422);
    }
    const card = await rateCardFor(input.banker, cfgRow.provider_id);
    let a: SettlementAmounts;
    try { a = settlementAmounts(gross, card, cfg); }
    catch (e) { throw new SettlementError((e as Error).message, "DEDUCTIONS_EXCEED", 422); }

    const ins = await rows<InstructionRow>("settlement", `
      INSERT INTO settlement_instructions
        (idempotency_key, banker_code, provider_id, kind, cycle_key, cutoff_at, config_id, config_version, currency,
         gross_minor, reserve_minor, upline_minor, katana_minor, downline_minor, fixed_minor, gst_minor, tds_minor, net_minor,
         rule_id, rule_version, beneficiary_id, transfer_mode, created_by)
      VALUES ($1,$2,$3::uuid,$4,$5,$6,$7::uuid,$8,'INR',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::uuid,$19,$20::uuid,$21,$22)
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING ${INSTR_COLS}
    `, [key, input.banker, cfgRow.provider_id, input.kind, input.cycle?.key ?? null, input.cycle?.cutoff.toISOString() ?? null,
        cfgRow.id, cfgRow.version, a.gross.toString(), a.reserve.toString(), a.upline.toString(), a.katana.toString(),
        a.downline.toString(), a.fixed.toString(), a.gst.toString(), a.tds.toString(), a.net.toString(),
        card.id, card.version, cfg.beneficiary_id, cfg.transfer_mode, input.actor]);
    const row = ins[0] ?? (await rows<InstructionRow>("settlement", `SELECT ${INSTR_COLS} FROM settlement_instructions WHERE idempotency_key = $1`, [key]))[0];
    // The payable leaves for "in transit" inside the lock, so the next raise sees it gone.
    if (row.state === "PENDING") await postInitiated(row);
    return row;
  });
  if (!created) return null;
  if (created.state === "PENDING") await initiate(created, input.actor);
  return getInstruction(created.id);
}

async function postInitiated(i: InstructionRow): Promise<void> {
  await postJournal({
    journal_type: "settlement.initiated", narration: `settlement ${i.id} raised`, currency: "INR",
    ref: { type: "settlement_instruction", id: i.id }, merchant_id: i.banker_code,
    idempotency_key: `settle:${i.id}:initiated`, lines: initiatedLines(i.banker_code, amountsOf(i)),
  });
}

/** PENDING → INITIATED: the journal (already posted under the lock; replayed here), the request, the hold. */
async function initiate(i: InstructionRow, actor: string): Promise<void> {
  await postInitiated(i);
  const ben = (await rows<any>("provider", `
    SELECT id::text, label, beneficiary_name, account_number, ifsc, bank_name, mobile_number, vpa, transfer_mode
      FROM provider_beneficiary_accounts WHERE id = $1::uuid AND active = true`, [i.beneficiary_id]).catch(() => []))[0];
  if (!ben || !i.provider_id) {
    await move(i.id, "PENDING", "HELD", actor, !ben ? "beneficiary account missing or inactive" : "banker is not mapped to a merchant", { held_from: "PENDING" });
    return;
  }
  const a = amountsOf(i);
  const net = rupees(a.net);
  const charges = {
    source: "settlement-engine", gross: rupees(a.gross), reserve: rupees(a.reserve),
    upline_charge: rupees(a.upline), katana_charge: rupees(a.katana), downline_charge: rupees(a.downline),
    fixed_fee: rupees(a.fixed), gst: rupees(a.gst), tds: rupees(a.tds), net,
  };
  // The request the banker pays and the merchant verifies, in the screens they already use. It
  // pays the net and covers the collections of gross less reserve (lib/banker-settled).
  const req = await rows<{ id: string }>("provider", `
    INSERT INTO provider_branch_settlements
      (provider_id, merchant_key, beneficiary_id, beneficiary_snapshot, amount, purpose, transfer_mode, note, status,
       requested_by, channel_type, gross_amount, net_amount, charges, rule_id, rule_version, instruction_id)
    VALUES ($1::uuid,$2,$3::uuid,$4::jsonb,$5,$6,$7,$8,'REQUESTED','settlement-engine',NULL,$9,$5,$10::jsonb,$11::uuid,$12,$13::uuid)
    ON CONFLICT (instruction_id) WHERE instruction_id IS NOT NULL DO NOTHING
    RETURNING id::text
  `, [i.provider_id, i.banker_code, ben.id, JSON.stringify(ben), net, purposeForAmount(Number(net)), i.transfer_mode ?? ben.transfer_mode,
      `Raised by the settlement engine${i.cycle_key ? ` (${i.cycle_key})` : ""}`, rupees(a.gross - a.reserve), JSON.stringify(charges),
      i.rule_id, i.rule_version, i.id]);
  const reqId = req[0]?.id ?? (await rows<{ id: string }>("provider", `SELECT id::text FROM provider_branch_settlements WHERE instruction_id = $1::uuid`, [i.id]))[0]?.id;
  await rows("provider", `INSERT INTO provider_audit_logs (provider_id, actor, action, payload) VALUES ($1::uuid, $2, 'provider.settlement.raised', $3::jsonb)`,
    [i.provider_id, actor, JSON.stringify({ branch: i.banker_code, amount: net, instruction_id: i.id, by: "settlement-engine" })]).catch(() => {});

  const cfg = (await rows<{ body: SettlementConfigBody }>("settlement", `SELECT body FROM settlement_configs WHERE id = $1::uuid`, [i.config_id]))[0]?.body;
  if (a.reserve > 0n && cfg) {
    await rows("settlement", `
      INSERT INTO settlement_reserve_holds (instruction_id, banker_code, amount_minor, release_at)
      VALUES ($1::uuid, $2, $3, now() + make_interval(days => $4::int)) ON CONFLICT (instruction_id) DO NOTHING
    `, [i.id, i.banker_code, a.reserve.toString(), cfg.reserve_hold_days]);
  }
  await move(i.id, "PENDING", "INITIATED", actor, "settlement request raised to the banker", { branch_settlement_id: reqId });
}

/** The engine follows each open instruction's banker→merchant request. */
export async function followRequests(actor = "settlement-engine"): Promise<{ moved: number; errors: string[] }> {
  const open = await rows<InstructionRow>("settlement", `
    SELECT ${INSTR_COLS} FROM settlement_instructions
     WHERE branch_settlement_id IS NOT NULL AND state IN ('INITIATED','IN_TRANSIT','HELD','SETTLED')
       AND updated_at > now() - interval '120 days'`);
  if (!open.length) return { moved: 0, errors: [] };
  const reqs = await rows<{ id: string; status: string; utr: string | null }>("provider",
    `SELECT id::text, status, utr FROM provider_branch_settlements WHERE id = ANY($1::uuid[])`, [open.map((i) => i.branch_settlement_id)]);
  const byId = new Map(reqs.map((r) => [r.id, r]));
  let moved = 0;
  const errors: string[] = [];
  for (const i of open) {
    const r = byId.get(i.branch_settlement_id!);
    if (!r) continue;
    try { if (await applyRequestStatus(i, r.status, r.utr, actor)) moved += 1; }
    catch (e) { errors.push(`${i.id}: ${(e as Error).message}`); }
  }
  return { moved, errors };
}

/** One instruction brought in line with its request's status. True when it moved. */
export async function applyRequestStatus(i: InstructionRow, status: string, utr: string | null, actor: string): Promise<boolean> {
  let want = stateForBranchStatus(status);
  // Back from a hold on the request's side: to where the instruction was held from.
  if (want == null && i.state === "HELD") want = i.held_from ?? "INITIATED";
  if (want == null || want === i.state) {
    if (utr && utr !== i.utr && !isFinal(i.state)) await rows("settlement", `UPDATE settlement_instructions SET utr = $2 WHERE id = $1::uuid`, [i.id, utr]);
    return false;
  }
  const a = amountsOf(i);
  // A request verified straight from "requested" passes through "in transit".
  if (want === "SETTLED" && i.state === "INITIATED") {
    if (!(await move(i.id, "INITIATED", "IN_TRANSIT", actor, `request ${status.toLowerCase()}`, { utr }))) return false;
    i = { ...i, state: "IN_TRANSIT" };
  }
  if (want === "HELD") {
    if (!canMove(i.state, "HELD")) return false;
    return move(i.id, i.state, "HELD", actor, `request ${status.toLowerCase()}`, { held_from: i.state });
  }
  if (i.state === "HELD" && (want === "IN_TRANSIT" || want === "SETTLED") && i.held_from === "INITIATED") {
    if (!(await move(i.id, "HELD", "INITIATED", actor, "hold lifted"))) return false;
    i = { ...i, state: "INITIATED" };
    if (want === "SETTLED") { await move(i.id, "INITIATED", "IN_TRANSIT", actor, `request ${status.toLowerCase()}`, { utr }); i = { ...i, state: "IN_TRANSIT" }; }
  } else if (i.state === "HELD" && want === "SETTLED") {
    if (!(await move(i.id, "HELD", i.held_from ?? "IN_TRANSIT", actor, "hold lifted"))) return false;
    i = { ...i, state: i.held_from ?? "IN_TRANSIT" };
  }
  if (!canMove(i.state, want, i.held_from)) return false;

  if (want === "SETTLED") {
    await postJournal({
      journal_type: "settlement.settled", narration: `settlement ${i.id} paid and verified`, currency: "INR",
      ref: { type: "settlement_instruction", id: i.id }, merchant_id: i.banker_code,
      idempotency_key: `settle:${i.id}:settled`, lines: settledLines(i.banker_code, a.net),
    });
  } else if (want === "FAILED") {
    await postJournal({
      journal_type: "settlement.reversed", narration: `settlement ${i.id} failed (request ${status.toLowerCase()})`, currency: "INR",
      ref: { type: "settlement_instruction", id: i.id }, merchant_id: i.banker_code,
      idempotency_key: `settle:${i.id}:failed`, lines: reversed(initiatedLines(i.banker_code, a)),
    });
    await rows("settlement", `UPDATE settlement_reserve_holds SET state = 'CANCELLED' WHERE instruction_id = $1::uuid AND state = 'HELD'`, [i.id]);
  } else if (want === "REVERSED") {
    await postJournal({
      journal_type: "settlement.reversed", narration: `settlement ${i.id} reversed after it was verified`, currency: "INR",
      ref: { type: "settlement_instruction", id: i.id }, merchant_id: i.banker_code,
      idempotency_key: `settle:${i.id}:reversed`,
      lines: [...reversed(settledLines(i.banker_code, a.net)), ...reversed(initiatedLines(i.banker_code, a))],
    });
    await rows("settlement", `UPDATE settlement_reserve_holds SET state = 'CANCELLED' WHERE instruction_id = $1::uuid AND state = 'HELD'`, [i.id]);
  }
  return move(i.id, i.state, want, actor, `request ${status.toLowerCase()}`, utr ? { utr } : {});
}

/** Staff: cancel an instruction that never reached the banker (PENDING, or held from PENDING). */
export async function cancelInstruction(id: string, actor: string, reason: string): Promise<boolean> {
  const i = await getInstruction(id);
  if (!i) throw new SettlementError("no such settlement", "NOT_FOUND", 404);
  if (!canMove(i.state, "CANCELLED", i.held_from)) throw new SettlementError(`a ${i.state.toLowerCase()} settlement cannot be cancelled here; it follows the banker's request`, "NOT_CANCELLABLE");
  await postJournal({
    journal_type: "settlement.reversed", narration: `settlement ${i.id} cancelled`, currency: "INR",
    ref: { type: "settlement_instruction", id: i.id }, merchant_id: i.banker_code,
    idempotency_key: `settle:${i.id}:cancelled`, lines: reversed(initiatedLines(i.banker_code, amountsOf(i))),
  });
  return move(i.id, i.state, "CANCELLED", actor, reason);
}

/** Release every reserve hold that is due back to the merchant's payable. */
export async function releaseReserves(now = new Date()): Promise<{ released: number; errors: string[] }> {
  const due = await rows<{ id: string; instruction_id: string; banker_code: string; amount_minor: string }>("settlement", `
    SELECT h.id::text, h.instruction_id::text, h.banker_code, h.amount_minor::text
      FROM settlement_reserve_holds h JOIN settlement_instructions i ON i.id = h.instruction_id
     WHERE h.state = 'HELD' AND h.release_at <= $1 AND i.state IN ('INITIATED','IN_TRANSIT','SETTLED')
     ORDER BY h.release_at LIMIT 500`, [now.toISOString()]);
  let released = 0;
  const errors: string[] = [];
  for (const h of due) {
    try {
      await postJournal({
        journal_type: "reserve.release", narration: `reserve of settlement ${h.instruction_id} released`, currency: "INR",
        ref: { type: "settlement_reserve_hold", id: h.id }, merchant_id: h.banker_code,
        idempotency_key: `reserve:${h.id}:released`, lines: reserveReleaseLines(h.banker_code, BigInt(h.amount_minor)),
      });
      await rows("settlement", `UPDATE settlement_reserve_holds SET state = 'RELEASED', released_at = now() WHERE id = $1::uuid AND state = 'HELD'`, [h.id]);
      released += 1;
    } catch (e) { errors.push(`hold ${h.id}: ${(e as Error).message}`); }
  }
  return { released, errors };
}

/** Raise every cycle that is due now. A banker without an approved config, or paused, is skipped. */
export async function runDueCycles(now = new Date(), actor = "scheduler"): Promise<{ raised: number; skipped: number; errors: string[] }> {
  const cfgs = await rows<ConfigRow>("settlement", `
    SELECT ${CONFIG_COLS} FROM settlement_configs c
     WHERE state = 'ACTIVE' AND NOT EXISTS (SELECT 1 FROM settlement_controls x WHERE x.banker_code = c.banker_code AND x.paused)`);
  let raised = 0, skipped = 0;
  const errors: string[] = [];
  for (const c of cfgs) {
    const cycle = dueCycle(c.body, now);
    if (!cycle) continue;
    try {
      const done = await rows("settlement", `SELECT 1 FROM settlement_instructions WHERE idempotency_key = $1`, [`cycle:${c.banker_code}:${cycle.key}`]);
      if (done.length) continue;
      const r = await raiseInstruction({ banker: c.banker_code, kind: "SCHEDULED", cycle, actor });
      if (r) raised += 1; else skipped += 1;
    } catch (e) { errors.push(`${c.banker_code}: ${(e as Error).message}`); }
  }
  return { raised, skipped, errors };
}

export async function instructionsFor(banker: string | null, limit = 50): Promise<InstructionRow[]> {
  return rows<InstructionRow>("settlement", `
    SELECT ${INSTR_COLS} FROM settlement_instructions ${banker ? "WHERE banker_code = $1" : ""}
     ORDER BY created_at DESC LIMIT ${Math.min(Math.max(limit, 1), 200)}`, banker ? [banker] : []);
}
export async function instructionEvents(id: string): Promise<{ from_state: string | null; to_state: string; actor: string | null; reason: string | null; at: string }[]> {
  return rows("settlement", `SELECT from_state, to_state, actor, reason, at FROM settlement_instruction_events WHERE instruction_id = $1::uuid ORDER BY id`, [id]);
}
