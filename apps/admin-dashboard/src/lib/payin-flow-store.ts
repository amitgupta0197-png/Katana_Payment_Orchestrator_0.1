// A pay-in flow, read and written. The rules are in lib/payin-flow.
//
// WHO HOLDS THE SETTING. The dashboard's "Merchant" is a row of `providers`; its "Bankers" are
// the rows of `merchants` mapped under it, and a banker is who actually takes an order (the
// order's merchant_id, the owner of the Key + Salt). The flow is selected at two levels:
//
//   merchant  providers.payin_flow (provider 0017)                — the normal place to choose
//   banker    merchant_payment_config.payin_flow (merchant 0010)  — one banker's own, wins
//
// The flow an order obeys is the banker's own when it has one, else its merchant's, else UNSET
// (the old inferred routing).

import { rows } from "@/lib/pg";
import { providerForMerchant } from "@/lib/provider-integration";
import {
  merchantFlowOf, validateMerchantFlow, UNSET_FLOW,
  type MerchantFlow, type OrderFlow, type PayinFlow,
} from "@/lib/payin-flow";

export type FlowSource = "BANKER" | "MERCHANT" | "NONE";

export interface EffectiveFlow extends MerchantFlow {
  /** Where the flow in force comes from. */
  source: FlowSource;
  /** The banker's own setting (UNSET = inherits). */
  own: MerchantFlow;
  /** The setting of the merchant the banker is mapped under (UNSET when none or not mapped). */
  inherited: MerchantFlow;
  providerId: string | null;
}

/** The flow selected for a merchant (a `providers` row). */
export async function getProviderFlow(providerId: string | null | undefined): Promise<MerchantFlow> {
  if (!providerId) return UNSET_FLOW;
  const r = await rows<{ payin_flow: string; payin_active_flow: string | null }>("provider",
    `SELECT payin_flow, payin_active_flow FROM providers WHERE id = $1::uuid`, [providerId]).catch(() => []);
  return r.length ? merchantFlowOf(r[0].payin_flow, r[0].payin_active_flow) : UNSET_FLOW;
}

/** A banker's own setting, ignoring its merchant's. */
export async function getBankerOwnFlow(merchantCode: string | null | undefined): Promise<MerchantFlow> {
  if (!merchantCode) return UNSET_FLOW;
  const r = await rows<{ payin_flow: string; payin_active_flow: string | null }>("merchant",
    `SELECT payin_flow, payin_active_flow FROM merchant_payment_config WHERE merchant_code = $1`,
    [merchantCode]).catch(() => []);
  return r.length ? merchantFlowOf(r[0].payin_flow, r[0].payin_active_flow) : UNSET_FLOW;
}

/** The flow in force for a banker, and where it comes from. */
export async function getEffectiveFlow(merchantCode: string | null | undefined): Promise<EffectiveFlow> {
  if (!merchantCode) return { ...UNSET_FLOW, source: "NONE", own: UNSET_FLOW, inherited: UNSET_FLOW, providerId: null };
  const [own, providerId] = await Promise.all([
    getBankerOwnFlow(merchantCode),
    providerForMerchant(merchantCode).catch(() => null),
  ]);
  const inherited = await getProviderFlow(providerId);
  if (own.flow !== "UNSET") return { ...own, source: "BANKER", own, inherited, providerId };
  if (inherited.flow !== "UNSET") return { ...inherited, source: "MERCHANT", own, inherited, providerId };
  return { ...UNSET_FLOW, source: "NONE", own, inherited, providerId };
}

/**
 * The flow an order of this banker obeys. A banker with no setting anywhere, or a database
 * that does not have the columns yet, is UNSET — which keeps the routing it always had.
 */
export async function getMerchantFlow(merchantCode: string | null | undefined): Promise<MerchantFlow> {
  const e = await getEffectiveFlow(merchantCode);
  return { flow: e.flow, active: e.active };
}

interface Change { flow: PayinFlow | "UNSET"; active?: OrderFlow | null; by: string; note?: string | null }

function checked(c: Change): { flow: PayinFlow | "UNSET"; active: OrderFlow | null } | { error: string } {
  if (c.flow === "UNSET") return { flow: "UNSET", active: null };
  const bad = validateMerchantFlow(c.flow, c.active ?? null);
  return bad ? { error: bad } : { flow: c.flow, active: c.flow === "BOTH" ? c.active ?? null : null };
}

/** Select a merchant's flow (UNSET clears it) and record the change. */
export async function setProviderFlow(providerId: string, c: Change): Promise<{ ok: true; flow: MerchantFlow } | { ok: false; error: string }> {
  const v = checked(c);
  if ("error" in v) return { ok: false, error: v.error };
  const before = await getProviderFlow(providerId);
  const upd = await rows<{ id: string }>("provider", `
    UPDATE providers SET payin_flow = $2, payin_active_flow = $3, payin_flow_set_by = $4, payin_flow_set_at = now()
     WHERE id = $1::uuid RETURNING id::text
  `, [providerId, v.flow, v.active, c.by]);
  if (!upd.length) return { ok: false, error: "merchant not found" };
  if (before.flow !== v.flow || before.active !== v.active) {
    await rows("provider", `
      INSERT INTO provider_payin_flow_history (provider_id, from_flow, from_active_flow, to_flow, to_active_flow, changed_by, note)
      VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)
    `, [providerId, before.flow, before.active, v.flow, v.active, c.by, c.note?.trim() || null]);
  }
  return { ok: true, flow: { flow: v.flow, active: v.active } };
}

/** Give a banker a flow of its own (UNSET returns it to its merchant's) and record the change. */
export async function setBankerFlow(merchantCode: string, c: Change): Promise<{ ok: true; flow: MerchantFlow } | { ok: false; error: string }> {
  const v = checked(c);
  if ("error" in v) return { ok: false, error: v.error };
  const before = await getBankerOwnFlow(merchantCode);
  await rows("merchant", `
    INSERT INTO merchant_payment_config (merchant_code, payin_flow, payin_active_flow, payin_flow_set_by, payin_flow_set_at, updated_by, updated_at)
    VALUES ($1, $2, $3, $4, now(), $4, now())
    ON CONFLICT (merchant_code) DO UPDATE SET
      payin_flow = EXCLUDED.payin_flow, payin_active_flow = EXCLUDED.payin_active_flow,
      payin_flow_set_by = EXCLUDED.payin_flow_set_by, payin_flow_set_at = now(),
      updated_by = EXCLUDED.updated_by, updated_at = now()
  `, [merchantCode, v.flow, v.active, c.by]);
  if (before.flow !== v.flow || before.active !== v.active) {
    await rows("merchant", `
      INSERT INTO merchant_payin_flow_history (merchant_code, from_flow, from_active_flow, to_flow, to_active_flow, changed_by, note)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [merchantCode, before.flow, before.active, v.flow, v.active, c.by, c.note?.trim() || null]);
  }
  return { ok: true, flow: { flow: v.flow, active: v.active } };
}

export interface FlowHistoryRow {
  from_flow: string | null; from_active_flow: string | null; to_flow: string; to_active_flow: string | null;
  changed_by: string | null; note: string | null; changed_at: string;
}

const HISTORY_COLS = `from_flow, from_active_flow, to_flow, to_active_flow, changed_by, note, changed_at`;

export async function bankerFlowHistory(merchantCode: string): Promise<FlowHistoryRow[]> {
  return rows<FlowHistoryRow>("merchant",
    `SELECT ${HISTORY_COLS} FROM merchant_payin_flow_history WHERE merchant_code = $1 ORDER BY changed_at DESC LIMIT 20`,
    [merchantCode]).catch(() => []);
}

export async function providerFlowHistory(providerId: string): Promise<FlowHistoryRow[]> {
  return rows<FlowHistoryRow>("provider",
    `SELECT ${HISTORY_COLS} FROM provider_payin_flow_history WHERE provider_id = $1::uuid ORDER BY changed_at DESC LIMIT 20`,
    [providerId]).catch(() => []);
}
