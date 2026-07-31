// DT pay-in attribution — the link between real incoming money and a DT purchase lot.
//
// Business model: Katana advances USDT to a merchant; the merchant repays in pay-in
// "population" (incoming traffic collected through its bankers). This module answers two
// questions the DT engine could not answer on its own:
//
//   1. A pay-in just landed on banker X — whose lot does it repay?
//   2. How much population has merchant Y actually sent back so far?
//
// SAFETY: everything here is gated on DT_MODULE_ENABLED (dtEngineEnabled()). With the flag
// off, processPayin() is a no-op and pay-in ingestion behaves exactly as it does today.
// With it on, the engine still writes to the SHADOW ledger (dt_journal_entries /
// commission_entries), not the production ledger — see dt-engine.ts.
//
// NAMING: `banker_code` is merchants.merchant_code (the branch — UI "Banker").
// `payin_merchant_code` is providers.code (UI "Merchant"). They are different tables in
// different databases; see tools/migrations/provider/0014_dt_payin_assignment.sql.

import { rows } from "@/lib/pg";
import { auditDt } from "@/lib/dt";
import { dtEngineEnabled, reserveQuotaForMerchant, consumeReservation } from "@/lib/dt-engine";

const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

// ── Banker (branch) → Merchant (provider) ────────────────────────────────────
// provider_merchant_mappings.merchant_id holds a merchant UUID on newer rows and a
// merchant_code on very old ones (same wart scope.ts documents), so we match on both.
export async function merchantForBanker(bankerCode: string): Promise<string | null> {
  if (!bankerCode) return null;
  const [m] = await rows<{ id: string }>(
    "merchant", `SELECT id::text FROM merchants WHERE merchant_code = $1 LIMIT 1`, [bankerCode],
  ).catch(() => []);
  const candidates = [bankerCode, ...(m?.id ? [m.id] : [])];
  const [hit] = await rows<{ code: string }>(
    "provider",
    `SELECT p.code
       FROM provider_merchant_mappings mm JOIN providers p ON p.id = mm.provider_id
      WHERE mm.status = 'ACTIVE' AND mm.merchant_id::text = ANY($1::text[])
      LIMIT 1`,
    [candidates],
  ).catch(() => []);
  return hit?.code ?? null;
}

// ── Merchant (provider) → its bankers (branch codes) ─────────────────────────
// Mirrors scope.resolveProviderMerchants, but keyed by providers.code instead of a session.
export async function bankersForMerchant(payinMerchantCode: string): Promise<string[]> {
  if (!payinMerchantCode) return [];
  const maps = await rows<{ merchant_id: string }>(
    "provider",
    `SELECT mm.merchant_id::text AS merchant_id
       FROM provider_merchant_mappings mm JOIN providers p ON p.id = mm.provider_id
      WHERE p.code = $1 AND mm.status = 'ACTIVE'`,
    [payinMerchantCode],
  ).catch(() => []);
  const codes = new Set<string>();
  const uuids: string[] = [];
  for (const m of maps) {
    if (isUuid(m.merchant_id)) uuids.push(m.merchant_id);
    else codes.add(m.merchant_id);
  }
  if (uuids.length) {
    const res = await rows<{ merchant_code: string }>(
      "merchant", `SELECT merchant_code FROM merchants WHERE id = ANY($1::uuid[])`, [uuids],
    ).catch(() => []);
    for (const r of res) codes.add(r.merchant_code);
  }
  return [...codes];
}

// ── Admin assignment ─────────────────────────────────────────────────────────
export async function assignPayinMerchant(purchaseId: string, payinMerchantCode: string | null, actor: string) {
  const [before] = await rows<{ payin_merchant_code: string | null }>(
    "provider", `SELECT payin_merchant_code FROM dt_purchases WHERE id = $1::uuid`, [purchaseId],
  ).catch(() => []);
  if (!before) return { error: "purchase not found", status: 404 as const };
  if (payinMerchantCode) {
    const [p] = await rows<{ code: string }>(
      "provider", `SELECT code FROM providers WHERE code = $1 LIMIT 1`, [payinMerchantCode],
    ).catch(() => []);
    if (!p) return { error: `no merchant with code ${payinMerchantCode}`, status: 400 as const };
  }
  await rows("provider",
    `UPDATE dt_purchases SET payin_merchant_code = $2, updated_at = now() WHERE id = $1::uuid`,
    [purchaseId, payinMerchantCode]);
  await auditDt(actor, payinMerchantCode ? "PAYIN_MERCHANT_ASSIGNED" : "PAYIN_MERCHANT_CLEARED",
    "dt_purchase", purchaseId, before, { payin_merchant_code: payinMerchantCode });
  return { ok: true as const };
}

// ── The ingest hook ──────────────────────────────────────────────────────────
export type PayinOutcome =
  | { status: "SKIPPED"; reason: string }
  | { status: "CONSUMED"; purchase_id: string; banker_id: string; amount: number }
  | { status: "UNALLOCATED"; reason: string; amount: number };

/**
 * Attribute one confirmed incoming pay-in to a DT lot.
 *
 * Never throws and never rejects the pay-in: the money has already arrived. When it cannot
 * be attributed it is recorded in dt_unallocated_payins for admin to resolve. Idempotent on
 * alert_id, so a replayed alert neither double-consumes quota nor double-counts population.
 */
export async function processPayin(input: { alert_id: string; banker_code?: string | null; amount: number }): Promise<PayinOutcome> {
  if (!dtEngineEnabled()) return { status: "SKIPPED", reason: "DT_MODULE_ENABLED is off" };
  if (!input.alert_id || !(input.amount > 0)) return { status: "SKIPPED", reason: "no alert id or non-positive amount" };

  // Idempotency: already attributed, or already queued as unallocated?
  const [dup] = await rows<{ n: number }>(
    "provider",
    `SELECT (SELECT COUNT(*) FROM dt_payin_consumption WHERE alert_id = $1)
           + (SELECT COUNT(*) FROM dt_unallocated_payins WHERE alert_id = $1) AS n`,
    [input.alert_id],
  ).catch(() => [{ n: 0 } as { n: number }]);
  if ((dup?.n ?? 0) > 0) return { status: "SKIPPED", reason: "alert already attributed" };

  const bankerCode = input.banker_code ?? null;
  const merchantCode = bankerCode ? await merchantForBanker(bankerCode) : null;
  if (!merchantCode) return unallocated(input, bankerCode, null, "UNRESOLVED_MERCHANT");

  const reserved = await reserveQuotaForMerchant({
    order_ref: input.alert_id, payin_merchant_code: merchantCode, amount: input.amount,
  }).catch(() => null);
  // No ACTIVE lot assigned to this merchant, or none with enough remaining quota. Both mean
  // the same thing operationally: the money landed with nothing to repay.
  if (!reserved) return unallocated(input, bankerCode, merchantCode, "NO_ASSIGNED_LOT");

  const consumed = await consumeReservation({
    reservation_id: reserved.reservation_id,
    banker_id: reserved.banker_id,
    branch: bankerCode ?? undefined,
    actor: "payin-ingest",
  }).catch((e: Error) => ({ error: e.message }));
  if ("error" in consumed) return unallocated(input, bankerCode, merchantCode, "NO_CAPACITY");

  await rows("provider", `
    INSERT INTO dt_payin_consumption (alert_id, banker_code, payin_merchant_code, purchase_id, reservation_id, amount)
    VALUES ($1,$2,$3,$4::uuid,$5::uuid,$6) ON CONFLICT (alert_id) DO NOTHING
  `, [input.alert_id, bankerCode, merchantCode, reserved.purchase_id, reserved.reservation_id, input.amount]).catch(() => {});

  return { status: "CONSUMED", purchase_id: reserved.purchase_id, banker_id: reserved.banker_id, amount: input.amount };
}

async function unallocated(
  input: { alert_id: string; amount: number }, bankerCode: string | null,
  merchantCode: string | null, reason: string,
): Promise<PayinOutcome> {
  await rows("provider", `
    INSERT INTO dt_unallocated_payins (alert_id, banker_code, payin_merchant_code, amount, reason)
    VALUES ($1,$2,$3,$4,$5) ON CONFLICT (alert_id) DO NOTHING
  `, [input.alert_id, bankerCode, merchantCode, input.amount, reason]).catch(() => {});
  return { status: "UNALLOCATED", reason, amount: input.amount };
}

// ── Population KPIs ──────────────────────────────────────────────────────────
export interface Population {
  // What the merchant owes back, and what has actually come in against it.
  advanced: number;          // ₹ value of ACTIVE/EXHAUSTED lots assigned to this merchant
  allocated: number;         // traffic quota materialised from those lots
  consumed: number;          // population actually consumed against them
  outstanding: number;       // allocated − consumed (still to be repaid)
  unallocated_amount: number; // pay-ins that arrived with no lot to consume
  unallocated_count: number;
  payin_count: number;       // attributed pay-ins
  pct_repaid: number | null; // consumed / allocated
}

/**
 * Population for one merchant (providers.code), or across all assigned merchants when
 * omitted. `bankerId` narrows to lots bought by one DT banker — that is the view the DT
 * banker portal shows, since a banker must not see other bankers' positions.
 */
export async function payinPopulation(filter: { payin_merchant_code?: string; banker_id?: string } = {}): Promise<Population> {
  const where: string[] = ["p.payin_merchant_code IS NOT NULL"];
  const params: unknown[] = [];
  if (filter.payin_merchant_code) { params.push(filter.payin_merchant_code); where.push(`p.payin_merchant_code = $${params.length}`); }
  if (filter.banker_id) { params.push(filter.banker_id); where.push(`p.banker_id = $${params.length}`); }
  const w = where.join(" AND ");

  const [lots] = await rows<{ advanced: number; allocated: number; consumed: number }>(
    "provider", `
    SELECT COALESCE(SUM(p.total_amount),0)::float          AS advanced,
           COALESCE(SUM(a.allocated),0)::float             AS allocated,
           COALESCE(SUM(a.consumed),0)::float              AS consumed
      FROM dt_purchases p LEFT JOIN traffic_allocations a ON a.purchase_id = p.id
     WHERE ${w} AND p.status IN ('ACTIVE','EXHAUSTED','REFILLED')
  `, params).catch(() => [{ advanced: 0, allocated: 0, consumed: 0 }]);

  // Attributed pay-in count comes from the consumption log, which is keyed by merchant.
  const cWhere: string[] = ["1=1"];
  const cParams: unknown[] = [];
  if (filter.payin_merchant_code) { cParams.push(filter.payin_merchant_code); cWhere.push(`payin_merchant_code = $${cParams.length}`); }
  const [cnt] = await rows<{ payin_count: number }>(
    "provider", `SELECT COUNT(*)::int AS payin_count FROM dt_payin_consumption WHERE ${cWhere.join(" AND ")}`, cParams,
  ).catch(() => [{ payin_count: 0 }]);

  const [un] = await rows<{ amount: number; n: number }>(
    "provider", `
    SELECT COALESCE(SUM(amount),0)::float AS amount, COUNT(*)::int AS n
      FROM dt_unallocated_payins
     WHERE status = 'OPEN' ${filter.payin_merchant_code ? "AND payin_merchant_code = $1" : ""}
  `, filter.payin_merchant_code ? [filter.payin_merchant_code] : []).catch(() => [{ amount: 0, n: 0 }]);

  const allocated = lots?.allocated ?? 0;
  const consumed = lots?.consumed ?? 0;
  return {
    advanced: lots?.advanced ?? 0,
    allocated, consumed,
    outstanding: +(allocated - consumed).toFixed(2),
    unallocated_amount: un?.amount ?? 0,
    unallocated_count: un?.n ?? 0,
    payin_count: cnt?.payin_count ?? 0,
    pct_repaid: allocated > 0 ? +((consumed / allocated) * 100).toFixed(1) : null,
  };
}

/** Per-merchant population breakdown — the admin/merchant-side dashboard table. */
export async function populationByMerchant(): Promise<Array<Population & { payin_merchant_code: string; lots: number }>> {
  const list = await rows<{ payin_merchant_code: string; lots: number; advanced: number; allocated: number; consumed: number }>(
    "provider", `
    SELECT p.payin_merchant_code,
           COUNT(DISTINCT p.id)::int                AS lots,
           COALESCE(SUM(p.total_amount),0)::float   AS advanced,
           COALESCE(SUM(a.allocated),0)::float      AS allocated,
           COALESCE(SUM(a.consumed),0)::float       AS consumed
      FROM dt_purchases p LEFT JOIN traffic_allocations a ON a.purchase_id = p.id
     WHERE p.payin_merchant_code IS NOT NULL AND p.status IN ('ACTIVE','EXHAUSTED','REFILLED')
     GROUP BY p.payin_merchant_code ORDER BY consumed DESC
  `).catch(() => []);
  const counts = await rows<{ payin_merchant_code: string; n: number }>(
    "provider", `SELECT payin_merchant_code, COUNT(*)::int AS n FROM dt_payin_consumption GROUP BY payin_merchant_code`,
  ).catch(() => []);
  const unal = await rows<{ payin_merchant_code: string; amount: number; n: number }>(
    "provider", `SELECT payin_merchant_code, COALESCE(SUM(amount),0)::float AS amount, COUNT(*)::int AS n
                   FROM dt_unallocated_payins WHERE status='OPEN' GROUP BY payin_merchant_code`,
  ).catch(() => []);
  const cMap = new Map(counts.map((c) => [c.payin_merchant_code, c.n]));
  const uMap = new Map(unal.map((u) => [u.payin_merchant_code, u]));
  return list.map((l) => {
    const u = uMap.get(l.payin_merchant_code);
    return {
      ...l,
      outstanding: +(l.allocated - l.consumed).toFixed(2),
      unallocated_amount: u?.amount ?? 0,
      unallocated_count: u?.n ?? 0,
      payin_count: cMap.get(l.payin_merchant_code) ?? 0,
      pct_repaid: l.allocated > 0 ? +((l.consumed / l.allocated) * 100).toFixed(1) : null,
    };
  });
}
