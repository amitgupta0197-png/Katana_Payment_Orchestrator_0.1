// Pay-in limits: the rules. Pure — no database, no clock; lib/payin-limits-store reads the
// limits and the usage these rules are checked against.
//
// A limit comes from one of two places:
//
//   the banker   merchant_payment_config.payin_* (merchant 0012), set on the merchant page
//   the platform the defaults below, from the environment
//
// and a banker's own wins. Amounts are RUPEES, like vendor_payin_orders.amount.
//
// Checked, in this order, when a LIVE order is created (a test order moves no money, so only
// the rate limit applies to it):
//
//   RATE_LIMITED          429  more orders in the last second than max_tps
//   AMOUNT_BELOW_MIN      422  under the minimum
//   AMOUNT_ABOVE_MAX      422  over the banker's own maximum
//   UPI_LIMIT_EXCEEDED    422  over the UPI ceiling, for an order paid by UPI link and a banker
//                              with no maximum of its own. An order paid on a gateway's hosted
//                              page (cards, net banking) has no such ceiling.
//   DAILY_LIMIT_EXCEEDED  422  today's orders plus this one would pass the daily limit

export interface PayinLimits {
  min: number | null;
  max: number | null;
  daily: number | null;
  maxTps: number | null;
}

export const NO_LIMITS: PayinLimits = { min: null, max: null, daily: null, maxTps: null };

export interface PlatformPayinLimits extends PayinLimits {
  /** The most one UPI payment may be. Applies where the banker has no maximum of its own. */
  upiMax: number | null;
}

/** A positive number from an environment value, `fallback` when unset, null when set to 0 ("off"). */
function limit(v: string | undefined, fallback: number | null): number | null {
  if (v == null || v.trim() === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The platform defaults. UPI itself refuses a payment under ₹1 or over ₹1,00,000, so those two
 * are on by default; the daily and rate limits are off until set. 0 switches a default off.
 */
export function platformPayinLimits(env: Record<string, string | undefined> = process.env): PlatformPayinLimits {
  return {
    min: limit(env.PAYIN_MIN_AMOUNT, 1),
    max: null,
    upiMax: limit(env.PAYIN_UPI_MAX_AMOUNT, 100000),
    daily: limit(env.PAYIN_DEFAULT_DAILY_AMOUNT, null),
    maxTps: limit(env.PAYIN_DEFAULT_MAX_TPS, null),
  };
}

/** The limits in force for a banker: its own where set, else the platform's. */
export function effectivePayinLimits(own: PayinLimits, platform: PlatformPayinLimits): PlatformPayinLimits {
  return {
    min: own.min ?? platform.min,
    max: own.max ?? platform.max,
    upiMax: own.max != null ? null : platform.upiMax,   // a banker's own maximum replaces the UPI ceiling
    daily: own.daily ?? platform.daily,
    maxTps: own.maxTps ?? platform.maxTps,
  };
}

export type PayinLimitCode =
  | "RATE_LIMITED" | "AMOUNT_BELOW_MIN" | "AMOUNT_ABOVE_MAX" | "UPI_LIMIT_EXCEEDED" | "DAILY_LIMIT_EXCEEDED";

export interface PayinLimitBreach {
  code: PayinLimitCode;
  status: 422 | 429;
  /** The request field the limit is about. */
  field: "amount" | "txnid";
  limit: number;
  /** The value that broke it: the amount, the day's total with this order, or the orders in the last second. */
  actual: number;
  message: string;
}

export interface PayinUsage {
  /** Rupees of today's live orders that are not failed or expired. */
  dayAmount: number;
  /** Orders created in the last second. */
  lastSecond: number;
}

const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
// Paise, so a sum of rupee amounts is compared exactly (0.1 + 0.2 is not 0.3).
const paise = (n: number) => Math.round(n * 100);

export interface PayinLimitCheck {
  amount: number;
  livemode: boolean;
  /** The customer pays by a UPI link or QR (a P2P order, or a gateway's UPI intent). */
  upi: boolean;
  limits: PlatformPayinLimits;
  usage: PayinUsage;
}

/** The first limit this order breaks, or null. */
export function checkPayinLimits(c: PayinLimitCheck): PayinLimitBreach | null {
  const { amount, limits, usage } = c;
  if (limits.maxTps != null && usage.lastSecond >= limits.maxTps)
    return { code: "RATE_LIMITED", status: 429, field: "txnid", limit: limits.maxTps, actual: usage.lastSecond + 1,
      message: `too many orders: at most ${limits.maxTps} a second` };
  if (!c.livemode) return null;
  if (limits.min != null && paise(amount) < paise(limits.min))
    return { code: "AMOUNT_BELOW_MIN", status: 422, field: "amount", limit: limits.min, actual: amount,
      message: `amount is below the minimum of ${inr(limits.min)}` };
  if (limits.max != null && paise(amount) > paise(limits.max))
    return { code: "AMOUNT_ABOVE_MAX", status: 422, field: "amount", limit: limits.max, actual: amount,
      message: `amount is above the maximum of ${inr(limits.max)}` };
  if (c.upi && limits.upiMax != null && paise(amount) > paise(limits.upiMax))
    return { code: "UPI_LIMIT_EXCEEDED", status: 422, field: "amount", limit: limits.upiMax, actual: amount,
      message: `amount is above the UPI limit of ${inr(limits.upiMax)} for one payment` };
  return limits.daily != null ? dailyBreach(amount, usage.dayAmount, limits.daily) : null;
}

/** The daily-limit refusal for an order of `amount` on a day that already holds `dayAmount`, or null. */
export function dailyBreach(amount: number, dayAmount: number, daily: number): PayinLimitBreach | null {
  if (paise(dayAmount) + paise(amount) <= paise(daily)) return null;
  return { code: "DAILY_LIMIT_EXCEEDED", status: 422, field: "amount", limit: daily, actual: (paise(dayAmount) + paise(amount)) / 100,
    message: `this order would pass today's limit of ${inr(daily)} (${inr(dayAmount)} taken so far)` };
}

/** A pay-in order refused by a limit. The order API answers with its status, code, field and limit. */
export class PayinLimitError extends Error {
  constructor(readonly breach: PayinLimitBreach) { super(breach.message); }
  get status() { return this.breach.status; }
  get code() { return this.breach.code; }
}

/** The body an order API sends for a refused order. No gateway is named in it. */
export function payinLimitBody(b: PayinLimitBreach): { error: string; code: PayinLimitCode; field: string; limit: number; actual: number } {
  return { error: b.message, code: b.code, field: b.field, limit: b.limit, actual: b.actual };
}

/** Why a set of limits cannot be saved, or null. */
export function validatePayinLimits(l: PayinLimits): string | null {
  for (const [k, v] of Object.entries(l)) {
    if (v != null && !(Number.isFinite(v) && v > 0)) return `${k} must be above zero`;
  }
  if (l.maxTps != null && !Number.isInteger(l.maxTps)) return "orders a second must be a whole number";
  if (l.min != null && l.max != null && l.min > l.max) return "minimum is above maximum";
  if (l.max != null && l.daily != null && l.max > l.daily) return "maximum per order is above the daily limit";
  return null;
}
