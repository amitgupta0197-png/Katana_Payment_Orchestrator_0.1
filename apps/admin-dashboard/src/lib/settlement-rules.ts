// Settlement rule engine — resolve the applicable commission rule for a settlement and
// compute the deduction breakdown (gross → upline/Katana/downline charges → net).
//
// Resolution: most specific ACTIVE rule wins:
//   (provider, branch) > (provider, all branches) > (global default) > zero-charge.
// Every settlement snapshots the breakdown + rule id/version at raise time, so later
// pricing changes never affect history (BRD §6).

import { rows } from "@/lib/pg";

export interface SettlementRule {
  id: string; provider_id: string | null; merchant_key: string | null;
  upline_bps: number; katana_bps: number; downline_bps: number;
  fixed_fee: number; gst_bps: number; min_charge: number | null; max_charge: number | null;
  currency: string; effective_from: string; effective_to: string | null;
  version: number; reason: string | null; created_by: string | null;
}

export interface ChargeBreakdown {
  gross: number;
  upline_charge: number;
  katana_charge: number;
  downline_charge: number;
  fixed_fee: number;
  gst: number;
  total_charges: number;
  net: number;
  rule_id: string | null;
  rule_version: number | null;
  // echo of the applied rates so the breakdown is self-describing on old rows
  rates: { upline_bps: number; katana_bps: number; downline_bps: number; gst_bps: number };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

// Zero-charge fallback when no rule is configured — settlement proceeds at gross.
const ZERO: Omit<SettlementRule, "id"> & { id: null } = {
  id: null, provider_id: null, merchant_key: null,
  upline_bps: 0, katana_bps: 0, downline_bps: 0, fixed_fee: 0, gst_bps: 0,
  min_charge: null, max_charge: null, currency: "INR",
  effective_from: "", effective_to: null, version: 0, reason: null, created_by: null,
};

// Most specific rule active at `at` (default now). Specificity = branch match first,
// then provider-wide, then global; newest effective_from breaks ties.
export async function resolveRule(
  providerId: string, merchantKey: string, at?: Date,
): Promise<SettlementRule | (typeof ZERO)> {
  const t = (at ?? new Date()).toISOString();
  const r = await rows<SettlementRule>("provider", `
    SELECT id::text, provider_id::text, merchant_key, upline_bps, katana_bps, downline_bps,
           fixed_fee::float AS fixed_fee, gst_bps, min_charge::float AS min_charge,
           max_charge::float AS max_charge, currency, effective_from, effective_to,
           version, reason, created_by
      FROM provider_settlement_rules
     WHERE effective_from <= $3::timestamptz
       AND (effective_to IS NULL OR effective_to > $3::timestamptz)
       AND (provider_id IS NULL OR provider_id = $1::uuid)
       AND (merchant_key IS NULL OR merchant_key = $2)
     ORDER BY (provider_id IS NOT NULL AND merchant_key IS NOT NULL) DESC,
              (provider_id IS NOT NULL) DESC,
              effective_from DESC
     LIMIT 1
  `, [providerId, merchantKey, t]).catch(() => []);
  return r[0] ?? ZERO;
}

// Current applicable USDT settlement rate for a network (newest effective, unexpired).
// Returns null when no rate is declared — a USDT request cannot be raised without one.
export interface UsdtRate { id: string; network: string; settlement_rate: number; network_fee: number }
export async function currentUsdtRate(network: string): Promise<UsdtRate | null> {
  const r = await rows<UsdtRate>("provider", `
    SELECT id::text, network, settlement_rate::float AS settlement_rate, network_fee::float AS network_fee
      FROM provider_usdt_rates
     WHERE network = $1 AND effective_from <= now() AND (expiry_at IS NULL OR expiry_at > now())
     ORDER BY effective_from DESC LIMIT 1
  `, [network]).catch(() => []);
  return r[0] ?? null;
}

// Net INR ÷ rate − network fee = final USDT quantity (BRD §8), 2dp.
export function computeUsdtQuantity(netInr: number, rate: UsdtRate): { gross_qty: number; fee: number; final_qty: number } {
  const gross = r2(netInr / rate.settlement_rate);
  const fee = r2(rate.network_fee ?? 0);
  return { gross_qty: gross, fee, final_qty: r2(Math.max(0, gross - fee)) };
}

// gross → per-layer charges (bps of gross) + fixed fee, min/max-clamped, GST on the
// charge total → net payable by the downline.
export function computeCharges(gross: number, rule: SettlementRule | typeof ZERO): ChargeBreakdown {
  const upline = r2((gross * rule.upline_bps) / 10_000);
  const katana = r2((gross * rule.katana_bps) / 10_000);
  const downline = r2((gross * rule.downline_bps) / 10_000);
  let base = r2(upline + katana + downline + (rule.fixed_fee ?? 0));
  if (rule.min_charge != null && base < rule.min_charge) base = r2(rule.min_charge);
  if (rule.max_charge != null && base > rule.max_charge) base = r2(rule.max_charge);
  const gst = r2((base * rule.gst_bps) / 10_000);
  const total = r2(base + gst);
  return {
    gross: r2(gross),
    upline_charge: upline, katana_charge: katana, downline_charge: downline,
    fixed_fee: r2(rule.fixed_fee ?? 0), gst, total_charges: total,
    net: r2(Math.max(0, gross - total)),
    rule_id: rule.id, rule_version: rule.version || null,
    rates: { upline_bps: rule.upline_bps, katana_bps: rule.katana_bps, downline_bps: rule.downline_bps, gst_bps: rule.gst_bps },
  };
}
