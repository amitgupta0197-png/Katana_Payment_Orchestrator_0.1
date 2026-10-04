// Flow dashboards (/flows/intent, /flows/p2p, /flows/payout, /flows/health): the pure rules.
// STAFF ONLY — these screens name gateways. Read-only: nothing here changes routing, the MID
// switch or a payout; the pages link to the screens that do.
//
// Every figure is per flow (CLAUDE.md "Channel accounting"): an Intent figure counts Intent
// orders only, a P2P figure P2P orders only. Times are India time (IST). SQL lives in
// flow-dashboards-store.ts; this file has no I/O so the unit test can hold the rules.

export type Tone = "good" | "warn" | "bad" | "none";

/** Paid over ended orders (paid + failed + expired), 0 to 1; null when nothing has ended. */
export function successRate(paid: number, ended: number): number | null {
  if (!ended || ended <= 0) return null;
  return Math.round((paid / ended) * 10_000) / 10_000;
}

/** Green at 85% and over, amber from 60%, red under 60%; none when there is no rate. */
export function rateTone(rate: number | null | undefined): Tone {
  if (rate == null || Number.isNaN(rate)) return "none";
  if (rate >= 0.85) return "good";
  if (rate >= 0.6) return "warn";
  return "bad";
}

export function median(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// ── Failure reasons ──────────────────────────────────────────────────────────────

export type PayinFailureBucket = "EXPIRED_UNPAID" | "FAILED_AT_GATEWAY" | "CREATE_FAILED" | "OTHER";

export const PAYIN_FAILURE_LABEL: Record<PayinFailureBucket, string> = {
  EXPIRED_UNPAID: "Expired unpaid",
  FAILED_AT_GATEWAY: "Failed at gateway",
  CREATE_FAILED: "Gateway could not create it",
  OTHER: "Other",
};

/** Which bucket an ended, unpaid pay-in falls in, from its status and the gateway's text. */
export function payinFailureBucket(status: string | null | undefined, reason?: string | null): PayinFailureBucket {
  const s = (status ?? "").toUpperCase();
  const r = (reason ?? "").toLowerCase();
  if (/creat(e|ion) fail|could not create|create_failed/.test(r)) return "CREATE_FAILED";
  if (s === "EXPIRED") return "EXPIRED_UNPAID";
  if (s === "FAILED") return "FAILED_AT_GATEWAY";
  return "OTHER";
}

export type PayoutFailureBucket = "INSUFFICIENT_FUNDS" | "BENEFICIARY" | "REJECTED" | "PROCESSOR" | "RETURNED" | "OTHER";

export const PAYOUT_FAILURE_LABEL: Record<PayoutFailureBucket, string> = {
  INSUFFICIENT_FUNDS: "Not enough balance",
  BENEFICIARY: "Beneficiary / account",
  REJECTED: "Rejected or cancelled",
  PROCESSOR: "Processor error",
  RETURNED: "Returned by bank",
  OTHER: "Other",
};

/** Which bucket a failed / rejected / cancelled / returned payout falls in. */
export function payoutFailureBucket(status: string | null | undefined, reason?: string | null): PayoutFailureBucket {
  const s = (status ?? "").toUpperCase();
  const r = (reason ?? "").toLowerCase();
  if (s === "REVERSED" || /return(ed)?\b|reversed/.test(r)) return "RETURNED";
  if (/insufficient|balance|low fund|not enough/.test(r)) return "INSUFFICIENT_FUNDS";
  if (/beneficiar|account|ifsc|vpa|upi id|invalid name|name mismatch/.test(r)) return "BENEFICIARY";
  if (s === "REJECTED" || s === "CANCELLED" || /reject|cancel/.test(r)) return "REJECTED";
  if (/timeout|timed out|gateway|processor|provider|server|5\d\d|network|bank down|unavailable/.test(r)) return "PROCESSOR";
  return "OTHER";
}

/** Count rows into buckets, keeping every bucket of `order` (zero included) in that order. */
export function countBuckets<K extends string>(keys: K[], order: readonly K[], weights?: number[]): { key: K; n: number }[] {
  const m = new Map<K, number>(order.map((k) => [k, 0]));
  keys.forEach((k, i) => m.set(k, (m.get(k) ?? 0) + (weights?.[i] ?? 1)));
  return order.map((key) => ({ key, n: m.get(key) ?? 0 }));
}

// ── Payout modes ─────────────────────────────────────────────────────────────────

export type PayoutMode = "IMPS" | "NEFT" | "RTGS" | "UPI" | "OTHER";
export const PAYOUT_MODES: readonly PayoutMode[] = ["IMPS", "NEFT", "RTGS", "UPI", "OTHER"];

/** The rail a payout went on, from payout_rail / transfer_rail / settlement_mode (first that says). */
export function payoutMode(...hints: (string | null | undefined)[]): PayoutMode {
  for (const h of hints) {
    const t = (h ?? "").toUpperCase();
    if (!t) continue;
    if (t.includes("IMPS")) return "IMPS";
    if (t.includes("NEFT")) return "NEFT";
    if (t.includes("RTGS")) return "RTGS";
    if (t.includes("UPI")) return "UPI";
  }
  return "OTHER";
}

// ── Time (IST) ───────────────────────────────────────────────────────────────────

const IST_MS = 5.5 * 3600_000;

/** The IST wall-clock hour (0..23) of an instant. */
export function istHour(at: Date | string): number {
  const t = new Date(at).getTime() + IST_MS;
  return new Date(t).getUTCHours();
}

/** "14:00"-style label of the IST hour starting at `at`. */
export function istHourLabel(at: Date | string): string {
  return `${String(istHour(at)).padStart(2, "0")}:00`;
}

/** Start of the hour containing `now`, as an instant. */
function hourStart(now: Date): number {
  return Math.floor(now.getTime() / 3600_000) * 3600_000; // IST is UTC+5:30, so align on IST hours
}

export interface HourPoint { hour: string; label: string; orders: number; paid: number; ended: number; rate: number | null }

/**
 * The last `hours` IST hours ending with the current one, filled from per-hour rows (the
 * hour's start as an ISO instant); hours with no orders are present with zeros.
 * IST hours start on the half hour UTC, so rows must be truncated in IST (the store does).
 */
export function hourlySeries(rowsIn: { hour: string; orders: number; paid: number; ended: number }[], now: Date, hours = 24): HourPoint[] {
  const istNow = new Date(now.getTime() + IST_MS);
  const istHourStart = hourStart(istNow) - IST_MS; // the instant the current IST hour began
  const byHour = new Map(rowsIn.map((r) => [new Date(r.hour).getTime(), r]));
  const out: HourPoint[] = [];
  for (let i = hours - 1; i >= 0; i--) {
    const t = istHourStart - i * 3600_000;
    const r = byHour.get(t);
    const orders = r?.orders ?? 0, paid = r?.paid ?? 0, ended = r?.ended ?? 0;
    out.push({ hour: new Date(t).toISOString(), label: istHourLabel(new Date(t)), orders, paid, ended, rate: successRate(paid, ended) });
  }
  return out;
}

// ── Pending orders by time left ──────────────────────────────────────────────────

export interface ExpiryBuckets { overdue: number; within_1h: number; within_4h: number; within_24h: number; later: number }

/** Pending orders by seconds left before they expire (negative = already past expiry). */
export function expiryBuckets(secondsLeft: number[]): ExpiryBuckets {
  const b: ExpiryBuckets = { overdue: 0, within_1h: 0, within_4h: 0, within_24h: 0, later: 0 };
  for (const s of secondsLeft) {
    if (s <= 0) b.overdue++;
    else if (s <= 3600) b.within_1h++;
    else if (s <= 4 * 3600) b.within_4h++;
    else if (s <= 24 * 3600) b.within_24h++;
    else b.later++;
  }
  return b;
}

// ── Merchants with a bad last hour ───────────────────────────────────────────────

export const LOW_SUCCESS_RATE = 0.8;
export const LOW_SUCCESS_MIN_ORDERS = 5;

export interface MerchantHour { provider_id: string; provider_name: string; orders: number; paid: number; ended: number }

/** Merchants (providers) under 80% success over their last hour, with at least 5 orders. */
export function lowSuccessMerchants(list: MerchantHour[], minRate = LOW_SUCCESS_RATE, minOrders = LOW_SUCCESS_MIN_ORDERS): (MerchantHour & { rate: number | null })[] {
  return list
    .filter((m) => m.orders >= minOrders)
    .map((m) => ({ ...m, rate: successRate(m.paid, m.ended) }))
    .filter((m) => m.rate != null && m.rate < minRate)
    .sort((a, b) => (a.rate ?? 0) - (b.rate ?? 0));
}

/** Sum per-banker rows into per-merchant rows, through the banker → merchant map. */
export function rollUpToMerchants(
  bankers: { code: string; orders: number; paid: number; ended: number }[],
  merchantOf: Map<string, { id: string; name: string }>,
): MerchantHour[] {
  const m = new Map<string, MerchantHour>();
  for (const b of bankers) {
    const p = merchantOf.get(b.code);
    if (!p) continue;
    const cur = m.get(p.id) ?? { provider_id: p.id, provider_name: p.name, orders: 0, paid: 0, ended: 0 };
    cur.orders += b.orders; cur.paid += b.paid; cur.ended += b.ended;
    m.set(p.id, cur);
  }
  return [...m.values()];
}

// ── Flow health tiles ────────────────────────────────────────────────────────────

export const HEALTH_FAIL_SHARE = 0.1;
export const HEALTH_MIN_ORDERS = 10;
export const HEALTH_MAX_QUEUE = 500;

export interface TileInput {
  /** Orders created in the last hour, how many of them ended, and how many ended unpaid / failed. */
  orders_1h: number;
  ended_1h: number;
  failed_1h: number;
  /** Payouts waiting (open), for the payout flow; 0 for pay-ins. */
  queue?: number;
  /** Activity over 24 hours; no activity and no queue = idle. */
  orders_24h: number;
}

/**
 * Red when over 10% of the last hour's ended orders failed (with at least 10 orders that hour)
 * or the queue is over 500; amber when anything failed in the last hour or the queue is over
 * half the limit; idle with nothing in 24 hours; else green.
 */
export function tileTone(t: TileInput): Tone {
  const queue = t.queue ?? 0;
  const failShare = t.ended_1h > 0 ? t.failed_1h / t.ended_1h : 0;
  if (queue > HEALTH_MAX_QUEUE) return "bad";
  if (t.orders_1h >= HEALTH_MIN_ORDERS && failShare > HEALTH_FAIL_SHARE) return "bad";
  if (t.orders_24h === 0 && queue === 0) return "none";
  if (failShare > HEALTH_FAIL_SHARE || queue > HEALTH_MAX_QUEUE / 2) return "warn";
  return "good";
}

/** Why a tile is red, in words, or null when it is not. */
export function tileReason(t: TileInput): string | null {
  const queue = t.queue ?? 0;
  if (queue > HEALTH_MAX_QUEUE) return `${queue} payouts waiting (over ${HEALTH_MAX_QUEUE})`;
  const failShare = t.ended_1h > 0 ? t.failed_1h / t.ended_1h : 0;
  if (t.orders_1h >= HEALTH_MIN_ORDERS && failShare > HEALTH_FAIL_SHARE)
    return `${Math.round(failShare * 100)}% failed in the last hour (${t.failed_1h} of ${t.ended_1h})`;
  return null;
}

// ── Request parsing and CSV ──────────────────────────────────────────────────────

const CODE_RE = /^[A-Za-z0-9._:-]{1,64}$/;

/** A banker code from ?banker=, or null when absent or not a plausible code. */
export function parseBanker(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return t && CODE_RE.test(t) ? t : null;
}

/** ?mode=live|test; anything else falls back to the dashboard's own Test / Live setting. */
export function parseMode(v: string | null | undefined, fallbackLive: boolean): boolean {
  if (v === "live") return true;
  if (v === "test") return false;
  return fallbackLive;
}

/** RFC 4180 CSV, with cells that look like formulas defused for spreadsheets. */
export function toCsv(headers: string[], data: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) => {
    if (v == null) return "";
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers, ...data].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

export const pctText = (r: number | null | undefined) => (r == null ? "—" : `${Math.round(r * 1000) / 10}%`);
