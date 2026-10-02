// Pay-in compliance monitoring: the rules. Pure — lib/payin-compliance-store gathers the
// figures these are checked against and keeps the flags.
//
// The rules look at a banker's LIVE, PAID orders. Each one is a pattern the PMLA rules ask a
// payment business to notice; a flag is a prompt for a person to look, never a finding by
// itself. Thresholds are rupees.

export type ComplianceRule =
  | "STRUCTURING" | "VOLUME_SPIKE" | "NEW_MERCHANT_VOLUME" | "ROUND_AMOUNTS" | "CTR_THRESHOLD" | "HIGH_VALUE";
export type ComplianceSeverity = "INFO" | "WARN" | "CRITICAL";

export interface ComplianceConfig {
  /** Orders at or above this are high-value (the same threshold that holds an order for review). */
  highValue: number;
  /** "Just under": from this fraction of highValue up to, not including, highValue. */
  structuringBand: number;
  /** How many just-under orders in one hour make a structuring flag. */
  structuringCount: number;
  /** A day over this multiple of the 30-day daily average is a spike… */
  spikeMultiple: number;
  /** …when the day is at least this much and the banker has at least this many earlier active days. */
  spikeFloor: number;
  spikeMinDays: number;
  /** A banker's first days, and the total that is too much for them. */
  newMerchantDays: number;
  newMerchantAmount: number;
  /** Share of round-thousand orders, over at least this many orders in the day. */
  roundShare: number;
  roundMinOrders: number;
  /** A day's total above this is looked at for a cash transaction report. */
  ctrAmount: number;
}

export const COMPLIANCE_DEFAULTS: ComplianceConfig = {
  highValue: 50_000, structuringBand: 0.9, structuringCount: 3,
  spikeMultiple: 3, spikeFloor: 50_000, spikeMinDays: 7,
  newMerchantDays: 7, newMerchantAmount: 500_000,
  roundShare: 0.8, roundMinOrders: 10,
  ctrAmount: 1_000_000,
};

/** One banker's figures for one day (India time). */
export interface MerchantDayStats {
  merchantId: string;
  dayAmount: number;
  dayCount: number;
  /** Orders of the day whose amount is a whole number of thousands. */
  roundCount: number;
  highValueCount: number;
  highValueAmount: number;
  /** The most just-under-threshold orders that fell inside any one hour of the day. */
  nearThresholdInHour: number;
  /** Paid total of the 30 days before this one, and how many of those days had a paid order. */
  priorAmount: number;
  priorActiveDays: number;
  /** Days since the banker's first live order, and its paid total since then. */
  ageDays: number;
  lifetimeAmount: number;
}

export interface ComplianceFlag {
  rule: ComplianceRule;
  severity: ComplianceSeverity;
  detail: Record<string, number>;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** The flags one banker's day raises. */
export function evaluateCompliance(s: MerchantDayStats, c: ComplianceConfig = COMPLIANCE_DEFAULTS): ComplianceFlag[] {
  const flags: ComplianceFlag[] = [];
  if (s.nearThresholdInHour >= c.structuringCount)
    flags.push({ rule: "STRUCTURING", severity: "CRITICAL",
      detail: { orders_in_one_hour: s.nearThresholdInHour, from: r2(c.highValue * c.structuringBand), below: c.highValue } });

  const average = s.priorAmount / 30;
  if (s.priorActiveDays >= c.spikeMinDays && s.dayAmount >= c.spikeFloor && s.dayAmount > average * c.spikeMultiple)
    flags.push({ rule: "VOLUME_SPIKE", severity: "WARN",
      detail: { day_amount: r2(s.dayAmount), daily_average_30d: r2(average), multiple: r2(s.dayAmount / average) } });

  if (s.ageDays <= c.newMerchantDays && s.lifetimeAmount > c.newMerchantAmount)
    flags.push({ rule: "NEW_MERCHANT_VOLUME", severity: "WARN",
      detail: { days_since_first_order: s.ageDays, amount: r2(s.lifetimeAmount), threshold: c.newMerchantAmount } });

  if (s.dayCount >= c.roundMinOrders && s.roundCount / s.dayCount > c.roundShare)
    flags.push({ rule: "ROUND_AMOUNTS", severity: "WARN",
      detail: { orders: s.dayCount, round_orders: s.roundCount, share: r2(s.roundCount / s.dayCount) } });

  if (s.dayAmount > c.ctrAmount)
    flags.push({ rule: "CTR_THRESHOLD", severity: "WARN", detail: { day_amount: r2(s.dayAmount), threshold: c.ctrAmount } });

  if (s.highValueCount > 0)
    flags.push({ rule: "HIGH_VALUE", severity: "INFO",
      detail: { orders: s.highValueCount, amount: r2(s.highValueAmount), threshold: c.highValue } });
  return flags;
}

export const RULE_LABEL: Record<ComplianceRule, string> = {
  STRUCTURING: "Several orders just under the high-value threshold within an hour",
  VOLUME_SPIKE: "Day's total far above the 30-day average",
  NEW_MERCHANT_VOLUME: "High volume in the first week",
  ROUND_AMOUNTS: "Mostly round-thousand amounts",
  CTR_THRESHOLD: "Day's total above the cash-transaction-report threshold",
  HIGH_VALUE: "High-value orders",
};
