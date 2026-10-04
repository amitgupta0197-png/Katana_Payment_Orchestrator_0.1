// What the MID switch screens show of a MID, for staff and for merchants and bankers.
//
// PURE. A merchant or banker never sees which payment processor an account is with, its MID code
// or its vault label (CLAUDE.md: never name a gateway to a merchant): a processor account is shown
// by its name with gateway names stripped. Their own UPI IDs are theirs, and shown.

import { stripGatewayNames } from "@/lib/merchant-safe";
import { healthOf, whyNot, inWindow, type HealthRule, DEFAULT_HEALTH, type Mid, type MidHealth, type MidSettings, type MidUsage } from "@/lib/mid-switch";

export interface MidViewRow {
  id: string; kind: Mid["kind"]; name: string; upi_id: string | null;
  gateway: string | null; env: string | null;   // staff only
  priority: number; weight: number; status: Mid["status"]; status_reason: string | null;
  limits: { min_amount: number | null; max_amount: number | null; daily_amount: number | null; daily_count: number | null; monthly_amount: number | null };
  window: { from: string | null; to: string | null; days: number[] | null; open_now: boolean };
  usage: MidUsage & { day_pct: number | null; month_pct: number | null; count_pct: number | null };
  health: { state: string; success_pct: number | null; why: string | null; ended: number; skip_unhealthy: boolean; min_success: number | null };
  /** Whether it could take a typical order now, and if not, why. */
  takes_traffic_now: boolean;
  why_not_now: string[];
  pinned: boolean;
  last_used: boolean;
  payee_name: string | null;
}

const pct = (used: number, limit: number | null) => (limit ? Math.min(100, Math.round((used / limit) * 1000) / 10) : null);

export function midViewRow(m: Mid & { usage: MidUsage; health: MidHealth }, o: {
  staff: boolean; settings: MidSettings & { last_mid_id?: string | null }; now: Date; rule?: HealthRule;
  account?: { gateway: string; env: string } | null;
}): MidViewRow {
  const rule = o.rule ?? DEFAULT_HEALTH;
  const h = healthOf(m, m.health, rule);
  // "Could it take an order now": checked with the smallest order it accepts.
  const probe = m.min_amount ?? 1;
  const { why } = whyNot({ mid: m, usage: m.usage, health: m.health }, probe, o.now, rule);
  const pinned = !!o.settings.pinned_mid_id && o.settings.pinned_mid_id === m.id
    && (!o.settings.pinned_until || Date.parse(o.settings.pinned_until) > o.now.getTime());
  const safe = (t: string | null) => (t == null ? null : o.staff ? t : stripGatewayNames(t, "processor"));
  return {
    id: m.id, kind: m.kind, name: safe(m.name)!, upi_id: m.upi_id,
    gateway: o.staff ? o.account?.gateway ?? null : null, env: o.staff ? o.account?.env ?? null : null,
    priority: m.priority, weight: m.weight, status: m.status, status_reason: safe(m.status_reason),
    limits: { min_amount: m.min_amount, max_amount: m.max_amount, daily_amount: m.daily_amount, daily_count: m.daily_count, monthly_amount: m.monthly_amount },
    window: { from: m.active_from, to: m.active_to, days: m.active_days, open_now: inWindow(m, o.now) },
    usage: { ...m.usage, day_pct: pct(m.usage.day_amount, m.daily_amount), month_pct: pct(m.usage.month_amount, m.monthly_amount), count_pct: pct(m.usage.day_count, m.daily_count) },
    health: { state: h.state, success_pct: h.success_pct, why: safe(h.why), ended: m.health.ended, skip_unhealthy: m.skip_unhealthy, min_success: m.health_min_success },
    takes_traffic_now: why.length === 0,
    why_not_now: why.map((w) => safe(w)!),
    pinned,
    last_used: o.settings.last_mid_id === m.id,
    payee_name: m.payee_name,
  };
}

/** Who made a change, as a merchant may read it. Staff actors are written as "katana:<email>". */
export function actorWords(actor: string, staff: boolean): string {
  if (actor === "switch") return "Automatic";
  if (actor.startsWith("katana:")) return staff ? actor.slice(7) : "Katana operations";
  return actor;
}

const ACTION_WORDS: Record<string, string> = {
  ADDED: "Added", UPDATED: "Changed", PAUSED: "Paused", RESUMED: "Resumed", DISABLED: "Disabled",
  PINNED: "Traffic switched by hand", UNPINNED: "Back to automatic", SETTINGS: "Switch settings changed",
  AUTO_SWITCH: "Traffic moved automatically", CREATE_FAILED: "Could not create an order", NONE_AVAILABLE: "No MID could take an order",
};

export function eventWords(e: { action: string; detail: Record<string, unknown> }, staff: boolean): string {
  const d = e.detail ?? {};
  let text = ACTION_WORDS[e.action] ?? e.action;
  if (e.action === "AUTO_SWITCH") text += `: ${d.from ?? "—"} → ${d.to ?? "—"}${Array.isArray(d.from_why_not) && d.from_why_not.length ? ` (${(d.from_why_not as string[]).join("; ")})` : ""}`;
  else if (e.action === "PINNED") text += d.until ? ` until ${new Date(String(d.until)).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}` : "";
  else if (e.action === "UPDATED") text += `: ${Object.keys(d).map((k) => k.replace(/_/g, " ")).join(", ")}`;
  else if (e.action === "CREATE_FAILED" && staff && d.error) text += `: ${String(d.error)}`;
  else if (e.action === "NONE_AVAILABLE" && Array.isArray(d.evaluated)) text += `: ${(d.evaluated as { name: string; why_not: string[] }[]).map((x) => `${x.name} (${x.why_not.join("; ")})`).join(", ")}`;
  else if ((e.action === "PAUSED" || e.action === "DISABLED") && d.reason) text += `: ${String(d.reason)}`;
  return staff ? text : stripGatewayNames(text, "processor");
}
