// The support bot's daily spending cap (all channels together). PURE.
//
// Spend is the model's own cost estimate of each answer (lib/support-bot/router costEstimate),
// summed over the India day and turned into rupees. At WARN_RATIO of the cap one ops alert is
// sent for the day; at the cap the bot stops asking the model and hands questions to the team
// until midnight IST.

export const WARN_RATIO = 0.8;

const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

/** The cap in rupees: SUPPORT_BOT_DAILY_BUDGET_INR, default 500 (a saved value on the staff page wins). */
export const defaultDailyBudgetInr = (env: Record<string, string | undefined> = process.env) => num(env.SUPPORT_BOT_DAILY_BUDGET_INR, 500);
/** Rupees per dollar for the estimate: SUPPORT_BOT_USD_INR, default 84. */
export const usdInr = (env: Record<string, string | undefined> = process.env) => num(env.SUPPORT_BOT_USD_INR, 84);

export interface BudgetState {
  spentInr: number;
  capInr: number;
  /** spent / cap, 0 when there is no cap */
  ratio: number;
  /** Past WARN_RATIO and not told yet today: send the one alert. */
  warnNow: boolean;
  /** At or over the cap: no more model calls today. */
  stop: boolean;
}

export function budgetState(spentUsd: number, capInr: number, warnedToday: boolean, rate = usdInr()): BudgetState {
  const spentInr = Math.round(spentUsd * rate * 100) / 100;
  const ratio = capInr > 0 ? spentInr / capInr : 0;
  return { spentInr, capInr, ratio, warnNow: ratio >= WARN_RATIO && !warnedToday, stop: capInr > 0 && spentInr >= capInr };
}
