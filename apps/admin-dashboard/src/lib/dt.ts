// DT (Digital Token) Business Model — shared data layer (Phase 2). Queries/mutations over
// the Phase-1 tables in providerservice_db (dbKey "provider"). Encodes the purchase
// lifecycle (BRD §10) and the 60/40 advance split; on funds confirmation it materialises
// the traffic quota + security reserve. Routing consumption + commission accrual are
// Phase 3 (gated on OD-02/OD-05) — nothing here touches live routing/settlement.

import { rows } from "@/lib/pg";

export type PurchaseStatus =
  | "DRAFT" | "PENDING_APPROVAL" | "AWAITING_FUNDS" | "FUNDS_SUBMITTED"
  | "ACTIVE" | "EXHAUSTED" | "SUSPENDED" | "REFILLED" | "CLOSED" | "REJECTED";

// Allowed forward transitions (BRD §10). Maker-checker enforced at the route layer.
const NEXT: Record<string, PurchaseStatus[]> = {
  DRAFT: ["PENDING_APPROVAL", "REJECTED"],
  PENDING_APPROVAL: ["AWAITING_FUNDS", "REJECTED"],
  AWAITING_FUNDS: ["FUNDS_SUBMITTED", "REJECTED"],
  FUNDS_SUBMITTED: ["ACTIVE", "REJECTED"],
  ACTIVE: ["EXHAUSTED", "SUSPENDED", "CLOSED"],
  EXHAUSTED: ["REFILLED", "CLOSED"],
};

export function canTransition(from: string, to: PurchaseStatus): boolean {
  return (NEXT[from] ?? []).includes(to);
}

export async function auditDt(actor: string, action: string, entity: string, entityId: string, before: unknown, after: unknown) {
  await rows("provider", `
    INSERT INTO dt_audit_logs (actor, action, entity, entity_id, before, after)
    VALUES ($1,$2,$3,$4,$5,$6)
  `, [actor, action, entity, entityId, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]).catch(() => {});
}

// ── Rate cards ────────────────────────────────────────────────────────────────
export async function currentRate(): Promise<{ id: string; rate: number; currency: string; version: number } | null> {
  const r = await rows<any>("provider", `
    SELECT id::text, rate::float AS rate, currency, version
      FROM dt_rate_cards WHERE status='ACTIVE' AND effective_from <= now()
        AND (effective_to IS NULL OR effective_to > now())
     ORDER BY effective_from DESC LIMIT 1
  `).catch(() => []);
  return r[0] ?? null;
}

export async function setRate(rate: number, currency: string, actor: string): Promise<void> {
  // supersede the previous active card, then insert the new one (versioned, effective-dated)
  const prev = await rows<{ version: number }>("provider",
    `SELECT COALESCE(MAX(version),0) AS version FROM dt_rate_cards`).catch(() => [{ version: 0 }]);
  await rows("provider", `UPDATE dt_rate_cards SET status='SUPERSEDED', effective_to=now() WHERE status='ACTIVE'`);
  await rows("provider", `
    INSERT INTO dt_rate_cards (currency, rate, status, version, created_by)
    VALUES ($1,$2,'ACTIVE',$3,$4)
  `, [currency, rate, (prev[0]?.version ?? 0) + 1, actor]);
  await auditDt(actor, "RATE_SET", "dt_rate_card", "", null, { rate, currency });
}

// ── Purchases ───────────────────────────────────────────────────────────────
export interface Purchase {
  id: string; banker_id: string; quantity: number; buy_rate: number; total_amount: number;
  priority_percent: number; security_percent: number; status: PurchaseStatus;
  payment_ref: string; created_by: string; approved_by: string;
  created_at: string; updated_at: string;
}

const PURCHASE_COLS = `id::text, banker_id, quantity::float AS quantity, buy_rate::float AS buy_rate,
  total_amount::float AS total_amount, priority_percent::float AS priority_percent,
  security_percent::float AS security_percent, status, COALESCE(payment_ref,'') AS payment_ref,
  COALESCE(created_by,'') AS created_by, COALESCE(approved_by,'') AS approved_by, created_at, updated_at`;

export async function listPurchases(filter: { banker_id?: string; status?: string } = {}): Promise<Purchase[]> {
  const where: string[] = []; const p: unknown[] = [];
  if (filter.banker_id) { p.push(filter.banker_id); where.push(`banker_id = $${p.length}`); }
  if (filter.status)    { p.push(filter.status);    where.push(`status = $${p.length}`); }
  return rows<Purchase>("provider", `
    SELECT ${PURCHASE_COLS} FROM dt_purchases
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY created_at DESC LIMIT 500
  `, p).catch(() => []);
}

export async function getPurchase(id: string): Promise<Purchase | null> {
  const r = await rows<Purchase>("provider", `SELECT ${PURCHASE_COLS} FROM dt_purchases WHERE id=$1::uuid`, [id]).catch(() => []);
  return r[0] ?? null;
}

export async function createPurchase(input: {
  banker_id: string; quantity: number; buy_rate: number; priority_percent?: number; security_percent?: number;
}, actor: string): Promise<Purchase> {
  const priority = input.priority_percent ?? 60;
  const security = input.security_percent ?? 40;
  const total = +(input.quantity * input.buy_rate).toFixed(2);
  const r = await rows<{ id: string }>("provider", `
    INSERT INTO dt_purchases (banker_id, quantity, buy_rate, total_amount, priority_percent, security_percent, status, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,'DRAFT',$7) RETURNING id::text
  `, [input.banker_id, input.quantity, input.buy_rate, total, priority, security, actor]);
  await auditDt(actor, "PURCHASE_CREATE", "dt_purchase", r[0].id, null, { ...input, total });
  return (await getPurchase(r[0].id))!;
}

// Generic status transition with a validation guard. `confirm-funds` also materialises the
// traffic allocation (priority%) + security reserve (40%) and records the funding row.
export async function transitionPurchase(
  id: string, to: PurchaseStatus, actor: string,
  extra?: { reference_no?: string; amount?: number },
): Promise<{ ok: true } | { error: string; status: number }> {
  const cur = await getPurchase(id);
  if (!cur) return { error: "purchase not found", status: 404 };
  if (!canTransition(cur.status, to)) return { error: `cannot move ${cur.status} → ${to}`, status: 409 };

  if (to === "ACTIVE") {
    // Finance confirms funds → record confirmation, split the advance 60/40.
    if (!extra?.reference_no) return { error: "reference_no required to confirm funds", status: 400 };
    await rows("provider", `
      INSERT INTO funding_confirmations (purchase_id, reference_no, amount, verified_by, verified_at)
      VALUES ($1,$2,$3,$4,now())
    `, [id, extra.reference_no, extra.amount ?? cur.total_amount, actor]);
    const allocated = +(cur.total_amount * cur.priority_percent / 100).toFixed(2);
    const held = +(cur.total_amount * cur.security_percent / 100).toFixed(2);
    await rows("provider", `
      INSERT INTO traffic_allocations (purchase_id, priority_percent, allocated) VALUES ($1,$2,$3)
    `, [id, cur.priority_percent, allocated]);
    await rows("provider", `
      INSERT INTO security_reserves (purchase_id, reserve_percent, held) VALUES ($1,$2,$3)
    `, [id, cur.security_percent, held]);
  }
  const setPay = to === "FUNDS_SUBMITTED" && extra?.reference_no ? `, payment_ref = '${extra.reference_no.replace(/'/g, "")}'` : "";
  const setApprover = to === "AWAITING_FUNDS" ? `, approved_by = '${actor.replace(/'/g, "")}'` : "";
  await rows("provider", `UPDATE dt_purchases SET status=$2, updated_at=now()${setPay}${setApprover} WHERE id=$1::uuid`, [id, to]);
  await auditDt(actor, `PURCHASE_${to}`, "dt_purchase", id, { status: cur.status }, { status: to });
  return { ok: true };
}

// ── Wallets ───────────────────────────────────────────────────────────────────
export async function dtWallet(bankerId: string) {
  return rows<any>("provider", `
    SELECT id::text, quantity::float AS quantity, buy_rate::float AS buy_rate,
           total_amount::float AS total_amount, status, created_at
      FROM dt_purchases WHERE banker_id=$1 AND status IN ('ACTIVE','EXHAUSTED','REFILLED')
     ORDER BY created_at DESC
  `, [bankerId]).catch(() => []);
}

export async function trafficWallet(bankerId: string) {
  const r = await rows<any>("provider", `
    SELECT COALESCE(SUM(a.allocated),0)::float AS allocated,
           COALESCE(SUM(a.reserved),0)::float  AS reserved,
           COALESCE(SUM(a.consumed),0)::float  AS consumed
      FROM traffic_allocations a JOIN dt_purchases p ON p.id=a.purchase_id
     WHERE p.banker_id=$1 AND a.status='ACTIVE'
  `, [bankerId]).catch(() => []);
  const w = r[0] ?? { allocated: 0, reserved: 0, consumed: 0 };
  const available = +(w.allocated - w.reserved - w.consumed).toFixed(2);
  const utilization = w.allocated > 0 ? +((w.consumed / w.allocated) * 100).toFixed(1) : 0;
  return { ...w, available, utilization };
}

// ── Dashboard KPIs (BRD §10 UI-001) ─────────────────────────────────────────
export async function dashboardKpis(filter: { banker_id?: string } = {}) {
  const bankerWhere = filter.banker_id ? `WHERE banker_id = $1` : "";
  const p = filter.banker_id ? [filter.banker_id] : [];
  const [tot] = await rows<any>("provider", `
    SELECT COUNT(*)::int AS purchases,
           COUNT(*) FILTER (WHERE status='ACTIVE')::int AS active,
           COALESCE(SUM(quantity),0)::float AS dt_purchased,
           COALESCE(SUM(total_amount),0)::float AS advance_debit
      FROM dt_purchases ${bankerWhere}
  `, p).catch(() => [{}]);
  const allocWhere = filter.banker_id
    ? `JOIN dt_purchases p ON p.id=a.purchase_id WHERE p.banker_id=$1`
    : `JOIN dt_purchases p ON p.id=a.purchase_id`;
  const [alloc] = await rows<any>("provider", `
    SELECT COALESCE(SUM(a.allocated),0)::float AS quota,
           COALESCE(SUM(a.reserved),0)::float  AS reserved,
           COALESCE(SUM(a.consumed),0)::float  AS consumed
      FROM traffic_allocations a ${allocWhere}
  `, p).catch(() => [{}]);
  const [res] = await rows<any>("provider", `
    SELECT COALESCE(SUM(s.held),0)::float AS reserve, COALESCE(SUM(s.released),0)::float AS released
      FROM security_reserves s JOIN dt_purchases p ON p.id=s.purchase_id ${filter.banker_id ? "WHERE p.banker_id=$1" : ""}
  `, p).catch(() => [{}]);
  const [comm] = await rows<any>("provider", `
    SELECT COALESCE(SUM(banker_commission),0)::float AS banker_commission,
           COALESCE(SUM(katana_margin),0)::float AS katana_margin,
           COALESCE(SUM(merchant_charge),0)::float AS merchant_charge
      FROM commission_entries
  `).catch(() => [{}]);
  const quota = alloc?.quota ?? 0, consumed = alloc?.consumed ?? 0, reserved = alloc?.reserved ?? 0;
  return {
    purchases: tot?.purchases ?? 0, active: tot?.active ?? 0,
    dt_purchased: tot?.dt_purchased ?? 0, advance_debit: tot?.advance_debit ?? 0,
    traffic_quota: quota, reserved, consumed_traffic: consumed,
    available_traffic: +(quota - reserved - consumed).toFixed(2),
    security_reserve: res?.reserve ?? 0,
    banker_commission: comm?.banker_commission ?? 0,
    katana_margin: comm?.katana_margin ?? 0,
    merchant_charge: comm?.merchant_charge ?? 0,
  };
}
