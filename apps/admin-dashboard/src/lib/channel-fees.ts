// Fees by pay-in channel, from the merchant's rate card (provider_settlement_rules, provider 0006).
//
// PURE (no `pg`): the store reads the rules and the paid totals, this does the arithmetic.
//
// A rate can be set for one channel (provider 0020): an INTENT rate applies to INTENT pay-ins and
// a P2P rate to P2P ones; a rate with no channel applies to both. The most specific rule in force
// on the day a pay-in was paid wins: one banker beats the whole merchant, which beats every
// merchant, then a channel's own rate beats one for both.
//
// The fee on a pay-in is its percentage layers (upline + Katana + downline) plus GST on them. The
// fixed fee and the min / max clamps belong to a settlement as a whole, not to one pay-in, so they
// are not part of this figure; the settlement records the charges it actually took.

export interface FeeRule {
  id: string;
  provider_id: string | null;
  merchant_key: string | null;
  channel_type: string | null;
  upline_bps: number;
  katana_bps: number;
  downline_bps: number;
  gst_bps: number;
  version: number;
  effective_from: string;
  effective_to: string | null;
}

export function pickFeeRule(rules: FeeRule[], s: { providerId: string | null; banker: string; channel: string; at: Date }): FeeRule | null {
  const t = s.at.getTime();
  const fits = rules.filter((r) =>
    Date.parse(r.effective_from) <= t && (r.effective_to == null || Date.parse(r.effective_to) > t)
    && (r.provider_id == null || r.provider_id === s.providerId)
    && (r.merchant_key == null || r.merchant_key === s.banker)
    && (r.channel_type == null || r.channel_type === s.channel));
  const score = (r: FeeRule) => (r.merchant_key ? 4 : 0) + (r.provider_id ? 2 : 0) + (r.channel_type ? 1 : 0);
  fits.sort((a, b) => score(b) - score(a) || Date.parse(b.effective_from) - Date.parse(a.effective_from));
  return fits[0] ?? null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** The fee on a paid amount under a rule: percentage layers plus GST on them. */
export function feeOn(gross: number, rule: FeeRule | null): number {
  if (!rule) return 0;
  const base = (gross * (rule.upline_bps + rule.katana_bps + rule.downline_bps)) / 10_000;
  return r2(base + (base * rule.gst_bps) / 10_000);
}

/** The total rate a rule charges, in basis points, GST included (for "2.36%"-style display). */
export function effectiveBps(rule: FeeRule | null): number {
  if (!rule) return 0;
  const base = rule.upline_bps + rule.katana_bps + rule.downline_bps;
  return Math.round((base + (base * rule.gst_bps) / 10_000) * 100) / 100;
}

export interface PaidGroup { banker: string; channel: string; day: string; gross: number }

/**
 * Fees per channel for groups of paid pay-ins (one group per banker, channel and IST day, so a
 * rate change mid-period is applied from its day on). `providerOf` maps a banker to its merchant.
 */
export function feesByChannel(groups: PaidGroup[], rules: FeeRule[], providerOf: (banker: string) => string | null): {
  byChannel: Record<string, number>; rated: Record<string, boolean>;
} {
  const byChannel: Record<string, number> = {};
  const rated: Record<string, boolean> = {};
  for (const g of groups) {
    // Noon IST on the day, so a rule that starts during the day counts from that day.
    const rule = pickFeeRule(rules, { providerId: providerOf(g.banker), banker: g.banker, channel: g.channel, at: new Date(`${g.day}T12:00:00+05:30`) });
    byChannel[g.channel] = r2((byChannel[g.channel] ?? 0) + feeOn(g.gross, rule));
    rated[g.channel] = (rated[g.channel] ?? false) || !!rule;
  }
  return { byChannel, rated };
}
