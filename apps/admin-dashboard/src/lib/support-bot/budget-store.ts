// The support bot's daily spending cap, stored and read (lib/support-bot/budget for the rules).
//
// Spend today (India day) = what the Telegram bot logged per message (support_bot_tg_answers.cost_usd:
// the gate and the answer together) + the cost of every portal and staff answer
// (support_bot_messages.usage, TELEGRAM conversations left out so nothing is counted twice).
// The cap and the day the warning went out are kept in support_bot_tg_settings.

import { rows } from "@/lib/pg";
import { raiseAlert } from "@/lib/ops-alert";
import { budgetState, defaultDailyBudgetInr, usdInr, type BudgetState } from "@/lib/support-bot/budget";

const IST_DAY_START = `(date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`;
const IST_TODAY = `to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD')`;

async function setting(key: string): Promise<string | null> {
  const r = await rows<{ value: string }>("merchant", `SELECT value FROM support_bot_tg_settings WHERE key = $1`, [key]).catch(() => []);
  return r[0]?.value ?? null;
}
async function putSetting(key: string, value: string, by: string): Promise<void> {
  await rows("merchant", `
    INSERT INTO support_bot_tg_settings (key, value, updated_by) VALUES ($1, $2, $3)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
  `, [key, value, by]);
}

/** Model spend today, in dollars, across every channel. */
export async function spendTodayUsd(): Promise<number> {
  const [tg, other] = await Promise.all([
    rows<{ usd: string | null }>("merchant", `
      SELECT COALESCE(SUM(cost_usd), 0)::text AS usd FROM support_bot_tg_answers WHERE created_at >= ${IST_DAY_START}`).catch(() => []),
    rows<{ usd: string | null }>("merchant", `
      SELECT COALESCE(SUM((m.usage->>'cost_usd_estimate')::numeric), 0)::text AS usd
        FROM support_bot_messages m JOIN support_bot_conversations c ON c.id = m.conversation_id
       WHERE m.role = 'assistant' AND m.usage IS NOT NULL AND c.channel <> 'TELEGRAM' AND m.created_at >= ${IST_DAY_START}`).catch(() => []),
  ]);
  return Number(tg[0]?.usd ?? 0) + Number(other[0]?.usd ?? 0);
}

/** The cap in rupees: the saved one, else SUPPORT_BOT_DAILY_BUDGET_INR (default 500). */
export async function dailyBudgetInr(): Promise<number> {
  const v = Number(await setting("daily_budget_inr"));
  return Number.isFinite(v) && v > 0 ? v : defaultDailyBudgetInr();
}
export async function setDailyBudgetInr(inr: number, by: string): Promise<void> {
  await putSetting("daily_budget_inr", String(Math.round(inr)), by);
}

/**
 * Today's spend against the cap. With `alert`, the one 80% warning of the day goes to the ops
 * chats (and is remembered, so it isn't sent again); at the cap the alert says the bot stopped.
 */
export async function budgetNow(opts: { alert?: boolean } = {}): Promise<BudgetState> {
  const [spent, cap, warnedDay, stoppedDay, today] = await Promise.all([
    spendTodayUsd(), dailyBudgetInr(), setting("budget_warned_day"), setting("budget_stopped_day"),
    rows<{ d: string }>("merchant", `SELECT ${IST_TODAY} AS d`).then((r) => r[0]?.d ?? "").catch(() => ""),
  ]);
  const s = budgetState(spent, cap, warnedDay === today, usdInr());
  if (opts.alert && today) {
    if (s.stop && stoppedDay !== today) {
      await putSetting("budget_stopped_day", today, "support-bot").catch(() => {});
      await raiseAlert({ key: `support-bot:budget:stop:${today}`, severity: "WARN", title: "Support assistant reached today's spending cap",
        body: `Spent about ₹${s.spentInr} of the ₹${s.capInr} cap today. It hands every question to the team until midnight IST. Raise the cap on Support bot → Telegram groups if needed.` }).catch(() => {});
    } else if (s.warnNow) {
      await putSetting("budget_warned_day", today, "support-bot").catch(() => {});
      await raiseAlert({ key: `support-bot:budget:warn:${today}`, severity: "WARN", title: "Support assistant at 80% of today's spending cap",
        body: `Spent about ₹${s.spentInr} of the ₹${s.capInr} cap today. At the cap it stops answering and hands questions to the team.` }).catch(() => {});
    }
  }
  return s;
}
