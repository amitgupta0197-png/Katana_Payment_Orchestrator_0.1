// DT engine (Phase 3) — the money-code: quota reservation/consumption, the commission
// waterfall, and shadow double-entry accrual. Feature-flagged OFF by default
// (DT_MODULE_ENABLED) and NOT wired into live pay-in routing — it is exercised via the
// /api/v1/dt/simulate endpoint (BRD Migration §23 "run shadow calculations", "pilot one
// banker"). Flip the flag + wire routing only after Finance signs off.
//
// ASSUMPTIONS (flagged for Finance — BRD open decisions):
//   OD-02 commission base = GROSS successful eligible traffic amount (BRD default).
//   OD-05 lot consumption = FIFO (oldest ACTIVE purchase allocation first).

import { db, rows } from "@/lib/pg";
import { auditDt } from "@/lib/dt";

export function dtEngineEnabled(): boolean {
  return process.env.DT_MODULE_ENABLED === "true";
}

// ── Commission rule resolution (BRD §14 hierarchy, most-specific wins) ────────
export interface CommissionRule { merchant_rate: number; banker_rate: number; version: number; scope: string }

export async function resolveCommissionRule(ctx: {
  banker_id?: string; merchant_group?: string; branch?: string; channel?: string;
}): Promise<CommissionRule> {
  // Try most-specific → global; first effective match wins.
  const attempts: Array<{ scope: string; where: string; val?: string }> = [
    { scope: "CHANNEL", where: "channel", val: ctx.channel },
    { scope: "BRANCH", where: "branch", val: ctx.branch },
    { scope: "MERCHANT_GROUP", where: "merchant_group", val: ctx.merchant_group },
    { scope: "BANKER", where: "banker_id", val: ctx.banker_id },
  ];
  for (const a of attempts) {
    if (!a.val) continue;
    const r = await rows<CommissionRule>("provider", `
      SELECT merchant_rate::float AS merchant_rate, banker_rate::float AS banker_rate, version, scope
        FROM commission_rules
       WHERE scope=$1 AND ${a.where}=$2 AND effective_from <= now()
         AND (effective_to IS NULL OR effective_to > now())
       ORDER BY effective_from DESC LIMIT 1
    `, [a.scope, a.val]).catch(() => []);
    if (r.length) return r[0];
  }
  const g = await rows<CommissionRule>("provider", `
    SELECT merchant_rate::float AS merchant_rate, banker_rate::float AS banker_rate, version, scope
      FROM commission_rules WHERE scope='GLOBAL' AND effective_from <= now()
        AND (effective_to IS NULL OR effective_to > now())
     ORDER BY effective_from DESC LIMIT 1
  `).catch(() => []);
  // BRD default waterfall if no rule row exists yet.
  return g[0] ?? { merchant_rate: 5.75, banker_rate: 4.50, version: 0, scope: "DEFAULT" };
}

export function computeCommission(base: number, rule: CommissionRule) {
  const merchant_charge = +(base * rule.merchant_rate / 100).toFixed(2);
  const banker_commission = +(base * rule.banker_rate / 100).toFixed(2);
  const katana_margin = +(merchant_charge - banker_commission).toFixed(2);
  return { merchant_charge, banker_commission, katana_margin };
}

// ── Atomic FIFO quota reservation (BRD §11 concurrency, §12 RT-003) ───────────
// Reserves `amount` against the oldest ACTIVE allocation for the banker that has enough
// available (allocated − reserved − consumed). Returns the reservation id, or null if no
// single lot has capacity (BRD RT-006 reject/reroute).
export async function reserveQuota(input: { order_ref: string; banker_id: string; amount: number }): Promise<{ reservation_id: string; allocation_id: string } | null> {
  const client = await db("provider").connect();
  try {
    await client.query("BEGIN");
    const alloc = await client.query(`
      SELECT a.id::text AS id
        FROM traffic_allocations a JOIN dt_purchases p ON p.id=a.purchase_id
       WHERE p.banker_id=$1 AND a.status='ACTIVE'
         AND (a.allocated - a.reserved - a.consumed) >= $2
       ORDER BY p.created_at ASC          -- FIFO across lots (OD-05)
       LIMIT 1 FOR UPDATE OF a
    `, [input.banker_id, input.amount]);
    if (!alloc.rows.length) { await client.query("ROLLBACK"); return null; }
    const allocationId = alloc.rows[0].id;
    await client.query(`UPDATE traffic_allocations SET reserved = reserved + $2, updated_at=now() WHERE id=$1::uuid`, [allocationId, input.amount]);
    const res = await client.query(`
      INSERT INTO traffic_reservations (order_ref, allocation_id, amount, status, expiry)
      VALUES ($1,$2::uuid,$3,'RESERVED', now() + interval '15 minutes') RETURNING id::text
    `, [input.order_ref, allocationId, input.amount]);
    await client.query("COMMIT");
    return { reservation_id: res.rows[0].id, allocation_id: allocationId };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Consume a reservation on success: RESERVED → CONSUMED, move reserved→consumed on the
// allocation, accrue commission + shadow journal, and if the lot is now exhausted mark it
// and open a refill request (BRD §16).
export async function consumeReservation(input: {
  reservation_id: string; banker_id: string;
  merchant_group?: string; branch?: string; channel?: string; actor?: string;
}): Promise<{ ok: true; commission: ReturnType<typeof computeCommission> } | { error: string }> {
  const client = await db("provider").connect();
  try {
    await client.query("BEGIN");
    const rr = await client.query(`SELECT id::text, allocation_id::text, amount::float AS amount, status FROM traffic_reservations WHERE id=$1::uuid FOR UPDATE`, [input.reservation_id]);
    if (!rr.rows.length) { await client.query("ROLLBACK"); return { error: "reservation not found" }; }
    const r = rr.rows[0];
    if (r.status !== "RESERVED") { await client.query("ROLLBACK"); return { error: `reservation is ${r.status}` }; }
    await client.query(`UPDATE traffic_reservations SET status='CONSUMED', updated_at=now() WHERE id=$1::uuid`, [r.id]);
    await client.query(`UPDATE traffic_allocations SET reserved = reserved - $2, consumed = consumed + $2, updated_at=now() WHERE id=$1::uuid`, [r.allocation_id, r.amount]);
    // exhaustion?
    const ex = await client.query(`SELECT (allocated - consumed) <= 0 AS exhausted, purchase_id::text FROM traffic_allocations WHERE id=$1::uuid`, [r.allocation_id]);
    if (ex.rows[0]?.exhausted) {
      await client.query(`UPDATE traffic_allocations SET status='EXHAUSTED' WHERE id=$1::uuid`, [r.allocation_id]);
      await client.query(`UPDATE dt_purchases SET status='EXHAUSTED', updated_at=now() WHERE id=$1::uuid AND status='ACTIVE'`, [ex.rows[0].purchase_id]);
      await client.query(`INSERT INTO dt_refill_requests (banker_id, allocation_id, trigger, status) VALUES ($1,$2::uuid,'EXHAUSTION','OPEN')`, [input.banker_id, r.allocation_id]);
    }
    await client.query("COMMIT");
    // commission accrual (outside the quota txn — inert accrual tables)
    const rule = await resolveCommissionRule({ banker_id: input.banker_id, merchant_group: input.merchant_group, branch: input.branch, channel: input.channel });
    const c = computeCommission(r.amount, rule);
    await rows("provider", `
      INSERT INTO commission_entries (transaction_ref, base_amount, merchant_charge, banker_commission, katana_margin, rule_version)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [input.reservation_id, r.amount, c.merchant_charge, c.banker_commission, c.katana_margin, rule.version]);
    // shadow double-entry (BRD §13) — NOT the production ledger
    await postShadow(input.reservation_id, input.banker_id, input.branch, c);
    await auditDt(input.actor ?? "engine", "TRAFFIC_CONSUMED", "traffic_reservation", input.reservation_id, null, { amount: r.amount, ...c });
    return { ok: true, commission: c };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function releaseReservation(input: { reservation_id: string; reason?: string }): Promise<{ ok: true } | { error: string }> {
  const client = await db("provider").connect();
  try {
    await client.query("BEGIN");
    const rr = await client.query(`SELECT allocation_id::text, amount::float AS amount, status FROM traffic_reservations WHERE id=$1::uuid FOR UPDATE`, [input.reservation_id]);
    if (!rr.rows.length) { await client.query("ROLLBACK"); return { error: "reservation not found" }; }
    if (rr.rows[0].status !== "RESERVED") { await client.query("ROLLBACK"); return { error: `reservation is ${rr.rows[0].status}` }; }
    await client.query(`UPDATE traffic_reservations SET status='RELEASED', reason=$2, updated_at=now() WHERE id=$1::uuid`, [input.reservation_id, input.reason ?? null]);
    await client.query(`UPDATE traffic_allocations SET reserved = reserved - $2, updated_at=now() WHERE id=$1::uuid`, [rr.rows[0].allocation_id, rr.rows[0].amount]);
    await client.query("COMMIT");
    return { ok: true };
  } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; }
  finally { client.release(); }
}

async function postShadow(txnRef: string, bankerId: string, branch: string | undefined, c: ReturnType<typeof computeCommission>) {
  await rows("provider", `
    INSERT INTO dt_journal_entries (event, debit_account, credit_account, amount, banker_id, branch, transaction_ref)
    VALUES
      ('merchant_fee',       'Merchant Settlement Payable', 'Fee Revenue/Payable',      $1, $4, $5, $6),
      ('banker_commission',  'Commission Expense/Clearing', 'Banker Commission Payable', $2, $4, $5, $6),
      ('katana_margin',      'Fee Revenue/Payable',         'Katana Margin',            $3, $4, $5, $6)
  `, [c.merchant_charge, c.banker_commission, c.katana_margin, bankerId, branch ?? null, txnRef]).catch(() => {});
}

// ── Orchestrator: process one order end-to-end (used by /simulate) ───────────
export async function processOrder(input: {
  order_ref: string; banker_id: string; amount: number; outcome: "SUCCESS" | "FAILURE";
  merchant_group?: string; branch?: string; channel?: string; actor?: string;
}): Promise<{ status: "CONSUMED" | "RELEASED" | "REJECTED"; reservation_id?: string; commission?: ReturnType<typeof computeCommission>; reason?: string }> {
  const reserved = await reserveQuota({ order_ref: input.order_ref, banker_id: input.banker_id, amount: input.amount });
  if (!reserved) return { status: "REJECTED", reason: "insufficient quota (no funded lot with capacity)" };
  if (input.outcome === "FAILURE") {
    await releaseReservation({ reservation_id: reserved.reservation_id, reason: "transaction failed" });
    return { status: "RELEASED", reservation_id: reserved.reservation_id };
  }
  const c = await consumeReservation({ reservation_id: reserved.reservation_id, banker_id: input.banker_id, merchant_group: input.merchant_group, branch: input.branch, channel: input.channel, actor: input.actor });
  if ("error" in c) return { status: "REJECTED", reservation_id: reserved.reservation_id, reason: c.error };
  return { status: "CONSUMED", reservation_id: reserved.reservation_id, commission: c.commission };
}

// ── Reconciliation invariants (BRD §15) ──────────────────────────────────────
export async function reconciliation() {
  const [q] = await rows<any>("provider", `
    SELECT COALESCE(SUM(allocated),0)::float AS allocated, COALESCE(SUM(reserved),0)::float AS reserved,
           COALESCE(SUM(consumed),0)::float AS consumed FROM traffic_allocations
  `).catch(() => [{}]);
  const [r] = await rows<any>("provider", `
    SELECT COUNT(*) FILTER (WHERE status='RESERVED')::int AS open_reservations,
           COUNT(*) FILTER (WHERE status='RESERVED' AND expiry < now())::int AS stale_reservations
      FROM traffic_reservations
  `).catch(() => [{}]);
  const [c] = await rows<any>("provider", `
    SELECT COALESCE(SUM(merchant_charge),0)::float AS merchant_charge,
           COALESCE(SUM(banker_commission),0)::float AS banker_commission,
           COALESCE(SUM(katana_margin),0)::float AS katana_margin FROM commission_entries
  `).catch(() => [{}]);
  const closing = +((q.allocated ?? 0) - (q.reserved ?? 0) - (q.consumed ?? 0)).toFixed(2);
  const marginOk = Math.abs(((c.merchant_charge ?? 0) - (c.banker_commission ?? 0)) - (c.katana_margin ?? 0)) < 0.01;
  return {
    quota: q, reservations: r, commission: c, available_closing: closing,
    invariants: {
      margin_waterfall_balances: marginOk,          // merchant − banker = katana
      no_stale_reservations: (r.stale_reservations ?? 0) === 0,
    },
  };
}
