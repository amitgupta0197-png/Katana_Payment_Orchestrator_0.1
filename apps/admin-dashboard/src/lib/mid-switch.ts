// The MID switch: which of a banker's own MIDs takes a pay-in.
//
// PURE (no `pg`): lib/mid-switch-store reads the MIDs, their usage and health, and records what
// happened; this decides. The tests hold it.
//
// A MID can take an order only when ALL of these hold:
//   status ACTIVE (not paused or disabled by a person)
//   inside its hours and days (India time)
//   the amount is within its per-order minimum and maximum
//   today's amount and count, and this month's amount, still have room for the order
//   healthy, unless it is set not to be skipped: enough recent orders were paid, and creating
//   orders on it has not just failed repeatedly
//
// Of those that can, the switch takes:
//   1. the MID a person switched traffic to (the manual switch), while it can take the order
//   2. PRIORITY mode: the one with the lowest priority number (ties: least used today)
//      WEIGHTED mode: one at random in proportion to its weight
// When none can, the order is refused (NO_ACCOUNT_AVAILABLE): a limit is a limit, and traffic
// never moves to another banker.

export const MID_KINDS = ["GATEWAY", "UPI"] as const;
export type MidKind = (typeof MID_KINDS)[number];
export const MID_MODES = ["PRIORITY", "WEIGHTED"] as const;
export type MidMode = (typeof MID_MODES)[number];
export type MidStatus = "ACTIVE" | "PAUSED" | "DISABLED";

export const MID_KIND_LABEL: Record<MidKind, string> = { GATEWAY: "Payment processor accounts (Intent)", UPI: "UPI IDs (P2P)" };

export interface Mid {
  id: string;
  banker_code: string;
  kind: MidKind;
  name: string;
  vault_label: string | null;
  upi_id: string | null;
  payee_name: string | null;
  priority: number;
  weight: number;
  status: MidStatus;
  status_reason: string | null;
  min_amount: number | null;
  max_amount: number | null;
  daily_amount: number | null;
  daily_count: number | null;
  monthly_amount: number | null;
  active_from: string | null;   // "HH:MM" or "HH:MM:SS", India time
  active_to: string | null;
  active_days: number[] | null; // 1 = Monday … 7 = Sunday
  skip_unhealthy: boolean;
  health_min_success: number | null;
}

export interface MidUsage { day_amount: number; day_count: number; month_amount: number }

export interface MidHealth {
  /** Ended orders in the health window, and how many were paid. */
  ended: number;
  paid: number;
  /** Failed attempts to create an order on it in the last few minutes. */
  recent_create_failures: number;
}

export interface MidSettings {
  enabled: boolean;
  mode: MidMode;
  pinned_mid_id: string | null;
  pinned_until: string | null;
}

export const DEFAULT_SETTINGS: MidSettings = { enabled: true, mode: "PRIORITY", pinned_mid_id: null, pinned_until: null };

/** Platform defaults for the health rule (env MID_HEALTH_*). */
export interface HealthRule { minOrders: number; minSuccessPct: number; maxCreateFailures: number }
export const DEFAULT_HEALTH: HealthRule = { minOrders: 10, minSuccessPct: 20, maxCreateFailures: 3 };

export function healthRuleFromEnv(env: Record<string, string | undefined> = process.env): HealthRule {
  const n = (v: string | undefined, d: number) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    minOrders: n(env.MID_HEALTH_MIN_ORDERS, DEFAULT_HEALTH.minOrders),
    minSuccessPct: n(env.MID_HEALTH_MIN_SUCCESS_PCT, DEFAULT_HEALTH.minSuccessPct),
    maxCreateFailures: n(env.MID_HEALTH_MAX_CREATE_FAILURES, DEFAULT_HEALTH.maxCreateFailures),
  };
}

export type HealthState = "HEALTHY" | "UNHEALTHY" | "UNKNOWN";

export function healthOf(mid: Pick<Mid, "health_min_success">, h: MidHealth, rule: HealthRule = DEFAULT_HEALTH): { state: HealthState; why: string | null; success_pct: number | null } {
  const pct = h.ended ? Math.round((h.paid / h.ended) * 1000) / 10 : null;
  if (h.recent_create_failures >= rule.maxCreateFailures) {
    return { state: "UNHEALTHY", why: `${h.recent_create_failures} orders could not be created on it in the last few minutes`, success_pct: pct };
  }
  if (h.ended < rule.minOrders || pct == null) return { state: "UNKNOWN", why: null, success_pct: pct };
  const floor = mid.health_min_success ?? rule.minSuccessPct;
  if (pct < floor) return { state: "UNHEALTHY", why: `only ${pct}% of its last ${h.ended} orders were paid (needs ${floor}%)`, success_pct: pct };
  return { state: "HEALTHY", why: null, success_pct: pct };
}

/** India time of `now`: minutes since midnight and ISO weekday (1 = Monday). */
export function istClock(now: Date): { minutes: number; weekday: number } {
  const t = new Date(now.getTime() + 330 * 60_000);   // IST has no daylight saving
  const weekday = ((t.getUTCDay() + 6) % 7) + 1;
  return { minutes: t.getUTCHours() * 60 + t.getUTCMinutes(), weekday };
}

const toMin = (s: string) => { const [h, m] = s.split(":").map(Number); return h * 60 + (m || 0); };

/** True when the MID takes traffic at `now`. A window from 22:00 to 06:00 crosses midnight. */
export function inWindow(mid: Pick<Mid, "active_from" | "active_to" | "active_days">, now: Date): boolean {
  const { minutes, weekday } = istClock(now);
  if (mid.active_from && mid.active_to) {
    const from = toMin(mid.active_from), to = toMin(mid.active_to);
    const inside = from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
    // A window that crosses midnight belongs to the day it started on.
    const day = from > to && minutes < to ? ((weekday + 5) % 7) + 1 : weekday;
    if (!inside) return false;
    if (mid.active_days?.length && !mid.active_days.includes(day)) return false;
    return true;
  }
  return !mid.active_days?.length || mid.active_days.includes(weekday);
}

const money = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export interface Candidate {
  mid: Mid;
  usage: MidUsage;
  health: MidHealth;
}

export interface Evaluated {
  id: string;
  name: string;
  eligible: boolean;
  /** Why it cannot take this order, in words; empty when it can. */
  why_not: string[];
  health: HealthState;
  success_pct: number | null;
}

/** Every reason this MID cannot take an order of `amount` now. */
export function whyNot(c: Candidate, amount: number, now: Date, rule: HealthRule = DEFAULT_HEALTH): { why: string[]; health: ReturnType<typeof healthOf> } {
  const m = c.mid, u = c.usage;
  const why: string[] = [];
  if (m.status !== "ACTIVE") why.push(m.status === "PAUSED" ? `paused${m.status_reason ? ` (${m.status_reason})` : ""}` : "disabled");
  if (!inWindow(m, now)) why.push("outside its hours");
  if (m.min_amount != null && amount < m.min_amount) why.push(`under its minimum of ${money(m.min_amount)}`);
  if (m.max_amount != null && amount > m.max_amount) why.push(`over its maximum of ${money(m.max_amount)}`);
  if (m.daily_amount != null && u.day_amount + amount > m.daily_amount + 0.005) why.push(`today's limit of ${money(m.daily_amount)} would be passed (${money(u.day_amount)} used)`);
  if (m.daily_count != null && u.day_count + 1 > m.daily_count) why.push(`today's ${m.daily_count} orders are used`);
  if (m.monthly_amount != null && u.month_amount + amount > m.monthly_amount + 0.005) why.push(`this month's limit of ${money(m.monthly_amount)} would be passed (${money(u.month_amount)} used)`);
  const health = healthOf(m, c.health, rule);
  if (health.state === "UNHEALTHY" && m.skip_unhealthy) why.push(`unhealthy: ${health.why}`);
  return { why, health };
}

export interface Choice {
  chosen: Mid | null;
  /** How it was chosen, in words. */
  reason: string;
  how: "MANUAL" | "PRIORITY" | "WEIGHTED" | "NONE";
  evaluated: Evaluated[];
}

const pinActive = (s: MidSettings, now: Date) =>
  !!s.pinned_mid_id && (!s.pinned_until || Date.parse(s.pinned_until) > now.getTime());

/**
 * Pick the MID for an order. `random` is injected so the weighted split is testable; `exclude`
 * are MIDs that already failed this order.
 */
export function chooseMid(cands: Candidate[], settings: MidSettings, amount: number, now: Date,
  opts: { random?: () => number; exclude?: string[]; rule?: HealthRule } = {}): Choice {
  const rule = opts.rule ?? DEFAULT_HEALTH;
  const exclude = new Set(opts.exclude ?? []);
  const evaluated: Evaluated[] = cands.map((c) => {
    const { why, health } = whyNot(c, amount, now, rule);
    if (exclude.has(c.mid.id)) why.push("could not create this order a moment ago");
    return { id: c.mid.id, name: c.mid.name, eligible: why.length === 0, why_not: why, health: health.state, success_pct: health.success_pct };
  });
  const ok = cands.filter((c) => evaluated.find((e) => e.id === c.mid.id)!.eligible);
  if (!ok.length) {
    return { chosen: null, how: "NONE", evaluated, reason: cands.length ? "no MID can take this payment now" : "no MID is set up" };
  }

  if (pinActive(settings, now)) {
    const pinned = ok.find((c) => c.mid.id === settings.pinned_mid_id);
    if (pinned) return { chosen: pinned.mid, how: "MANUAL", evaluated, reason: `switched by hand to ${pinned.mid.name}` };
  }
  const pinNote = pinActive(settings, now)
    ? ` (the MID switched to by hand cannot take it: ${evaluated.find((e) => e.id === settings.pinned_mid_id)?.why_not.join("; ") || "it is gone"})`
    : "";

  if (settings.mode === "WEIGHTED") {
    const weighted = ok.filter((c) => c.mid.weight > 0);
    const pool = weighted.length ? weighted : ok;
    const total = pool.reduce((a, c) => a + Math.max(c.mid.weight, weighted.length ? 0 : 1), 0);
    let r = (opts.random ?? Math.random)() * total;
    for (const c of pool) {
      r -= Math.max(c.mid.weight, weighted.length ? 0 : 1);
      if (r < 0) return { chosen: c.mid, how: "WEIGHTED", evaluated, reason: `weighted split (${c.mid.weight} of ${total})${pinNote}` };
    }
    const last = pool[pool.length - 1];
    return { chosen: last.mid, how: "WEIGHTED", evaluated, reason: `weighted split (${last.mid.weight} of ${total})${pinNote}` };
  }

  const sorted = [...ok].sort((a, b) => a.mid.priority - b.mid.priority || a.usage.day_amount - b.usage.day_amount || a.mid.name.localeCompare(b.mid.name));
  const first = sorted[0];
  const skipped = cands.filter((c) => c.mid.priority < first.mid.priority && !ok.includes(c));
  return {
    chosen: first.mid, how: "PRIORITY", evaluated,
    reason: skipped.length
      ? `priority ${first.mid.priority}; skipped ${skipped.map((s) => `${s.mid.name} (${evaluated.find((e) => e.id === s.mid.id)!.why_not.join("; ")})`).join(", ")}${pinNote}`
      : `priority ${first.mid.priority}${pinNote}`,
  };
}

/** The order cannot be taken by any MID of the banker. Surfaced as NO_ACCOUNT_AVAILABLE (503). */
export class NoMidAvailableError extends Error {
  readonly code = "NO_ACCOUNT_AVAILABLE" as const;
  readonly status = 503;
  constructor(readonly banker: string, readonly kind: MidKind, readonly evaluated: Evaluated[]) {
    super("no payment account can take this payment right now (limits used up, paused or outside their hours); try again later");
  }
}

/** Limits a person may set, checked before they are saved. */
export function validateMidLimits(m: Partial<Pick<Mid, "min_amount" | "max_amount" | "daily_amount" | "daily_count" | "monthly_amount" | "active_from" | "active_to" | "active_days">>): string | null {
  if (m.min_amount != null && m.max_amount != null && m.min_amount > m.max_amount) return "the minimum is above the maximum";
  if (m.max_amount != null && m.daily_amount != null && m.max_amount > m.daily_amount) return "one order's maximum is above the day's limit";
  if (m.daily_amount != null && m.monthly_amount != null && m.daily_amount > m.monthly_amount) return "the day's limit is above the month's";
  if ((m.active_from == null) !== (m.active_to == null)) return "give both the start and the end of its hours, or neither";
  if (m.active_from && m.active_to && m.active_from === m.active_to) return "its hours start and end at the same time";
  if (m.active_days && m.active_days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) return "days are 1 (Monday) to 7 (Sunday)";
  return null;
}
