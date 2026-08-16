// Downloadable transaction statement — periods, row shape and CSV layout.
//
// This module is PURE (no `pg`, no server imports) because the statement UI is a client
// component and needs the same period definitions the API uses; the queries live in
// `statement-data.ts`. Keep it that way — importing pg here breaks the client build.
//
// The layout mirrors the GPay Business statement a merchant already reconciles against
// (Payer/Receiver … Notes, in that order), with Katana's own reconciliation columns
// appended so one file answers both "what did GPay say" and "what did Katana match".

import type { CsvColumn } from "./csv";

// Every period boundary is an IST calendar boundary. The people downloading these files
// close their books on Indian dates, and the server runs UTC — "yesterday" resolved in
// UTC would cut each day 5h30m early and silently move evening payments into the wrong
// statement. A fixed offset is correct here: India has no DST.
export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export type StatementChannel = "ALL" | "CHECKOUT" | "VPA";

export type StatementPeriod =
  | "today" | "yesterday" | "last_week" | "last_month" | "last_fy" | "custom";

export interface StatementRange {
  /** Inclusive start instant. */
  from: Date;
  /** EXCLUSIVE end instant — always compare with `< to`. */
  to: Date;
  /** Human label for the screen, e.g. "Last week (Aug 3–Aug 9)". */
  label: string;
  /** Filename fragment, e.g. "20260803-20260809". */
  slug: string;
}

export const CHANNEL_LABELS: Record<StatementChannel, string> = {
  ALL: "All channels",
  CHECKOUT: "Merchant Hosted Checkout",
  VPA: "Gateway Hosted Checkout",
};

/** IST civil date parts of an instant. */
function istParts(at: Date) {
  const s = new Date(at.getTime() + IST_OFFSET_MS);
  return { y: s.getUTCFullYear(), m: s.getUTCMonth(), d: s.getUTCDate() };
}

/** The instant at which the given IST calendar date begins. */
function istMidnight(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m, d) - IST_OFFSET_MS);
}

function addDays(at: Date, days: number): Date {
  return new Date(at.getTime() + days * 86400000);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `20260803` — the IST calendar date of an instant, for filenames. */
function stamp(at: Date): string {
  const { y, m, d } = istParts(at);
  return `${y}${String(m + 1).padStart(2, "0")}${String(d).padStart(2, "0")}`;
}

/** `Aug 3` / `Aug 3, 2025` — the IST calendar date of an instant, for labels. */
function pretty(at: Date, withYear = false): string {
  const { y, m, d } = istParts(at);
  return `${MONTHS[m]} ${d}${withYear ? `, ${y}` : ""}`;
}

/**
 * A statement period, resolved against IST calendar boundaries.
 *
 * `to` is EXCLUSIVE. `last_week` is the previous Monday–Sunday (the ISO week), matching
 * what the GPay picker offers; `last_fy` is the Indian financial year (Apr 1 → Mar 31).
 * `custom` takes inclusive `YYYY-MM-DD` dates and widens `to` to the end of that day, so
 * picking the same date twice yields that one full day rather than an empty range.
 */
export function resolvePeriod(
  period: StatementPeriod,
  fromDate: string | null,
  toDate: string | null,
  now: Date = new Date(),
): StatementRange {
  const t = istParts(now);
  const todayStart = istMidnight(t.y, t.m, t.d);

  switch (period) {
    case "today":
      return { from: todayStart, to: now, label: "Today", slug: `${stamp(todayStart)}-${stamp(now)}` };

    case "yesterday": {
      const from = addDays(todayStart, -1);
      return { from, to: todayStart, label: "Yesterday", slug: `${stamp(from)}-${stamp(from)}` };
    }

    case "last_week": {
      // getUTCDay on the IST-shifted instant gives the IST weekday. Sunday is 0; treat it
      // as day 7 so a week runs Monday→Sunday.
      const shifted = new Date(todayStart.getTime() + IST_OFFSET_MS);
      const isoDow = shifted.getUTCDay() === 0 ? 7 : shifted.getUTCDay();
      const thisMonday = addDays(todayStart, -(isoDow - 1));
      const from = addDays(thisMonday, -7);
      const lastDay = addDays(thisMonday, -1);
      return {
        from, to: thisMonday,
        label: `Last week (${pretty(from)}–${pretty(lastDay)})`,
        slug: `${stamp(from)}-${stamp(lastDay)}`,
      };
    }

    case "last_month": {
      const from = istMidnight(t.y, t.m - 1, 1);   // Date.UTC normalises month -1 across years
      const to = istMidnight(t.y, t.m, 1);
      const p = istParts(from);
      return {
        from, to,
        label: `Last month (${["January","February","March","April","May","June","July","August","September","October","November","December"][p.m]} ${p.y})`,
        slug: `${stamp(from)}-${stamp(addDays(to, -1))}`,
      };
    }

    case "last_fy": {
      // Indian FY runs Apr(3)→Mar. Before April we are still in the FY that began last year.
      const currentFyStart = t.m >= 3 ? t.y : t.y - 1;
      const from = istMidnight(currentFyStart - 1, 3, 1);
      const to = istMidnight(currentFyStart, 3, 1);
      return {
        from, to,
        label: `Last financial year (${currentFyStart - 1}–${currentFyStart})`,
        slug: `${stamp(from)}-${stamp(addDays(to, -1))}`,
      };
    }

    case "custom": {
      const parse = (v: string | null): Date | null => {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((v ?? "").trim());
        return m ? istMidnight(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
      };
      // An unparseable or missing bound falls back to a sane window rather than erroring:
      // a statement with no start means "everything up to the end date".
      const from = parse(fromDate) ?? istMidnight(t.y, t.m, 1);
      const endDay = parse(toDate) ?? todayStart;
      // Swapped dates are a slip, not an attack — order them rather than return nothing.
      const [lo, hi] = from <= endDay ? [from, endDay] : [endDay, from];
      const to = addDays(hi, 1);
      return {
        from: lo, to,
        label: `${pretty(lo, true)} – ${pretty(hi, true)}`,
        slug: `${stamp(lo)}-${stamp(hi)}`,
      };
    }
  }
}

/** The picker options, in the order the screen shows them. */
export const PERIOD_OPTIONS: { value: StatementPeriod; label: string }[] = [
  { value: "today", label: "Today (12 A.M.–Now)" },
  { value: "yesterday", label: "Yesterday" },
  { value: "last_week", label: "Last week" },
  { value: "last_month", label: "Last month" },
  { value: "last_fy", label: "Last financial year" },
  { value: "custom", label: "Custom date range" },
];

export interface StatementRow {
  channel: StatementChannel;      // CHECKOUT | VPA — never ALL on a row
  /** Payer (a credit) or the customer (an order). */
  party: string | null;
  paid_via: string | null;
  type: string | null;
  created_at: string | Date | null;
  txn_id: string | null;
  amount: number;
  fee: number;
  net: number;
  status: string | null;
  updated_at: string | Date | null;
  notes: string | null;
  rrn: string | null;
  banker_code: string | null;
  order_id: string | null;
}

/** `2026-08-14 22:36:39` in IST — the format the GPay statement uses. */
export function istStamp(v: string | Date | null | undefined): string {
  if (!v) return "";
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  const s = new Date(d.getTime() + IST_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${s.getUTCFullYear()}-${p(s.getUTCMonth() + 1)}-${p(s.getUTCDate())} `
       + `${p(s.getUTCHours())}:${p(s.getUTCMinutes())}:${p(s.getUTCSeconds())}`;
}

/** Two decimals, no thousands separator or symbol — a statement column Excel can sum. */
function money(n: number): string {
  return (Number.isFinite(n) ? n : 0).toFixed(2);
}

// GPay's eleven columns in GPay's order, then Katana's four. A merchant who already has a
// sheet built on the GPay export can paste this in beside it; the extra columns are what
// makes the row traceable back to a Katana order.
export const STATEMENT_COLUMNS: CsvColumn<StatementRow>[] = [
  { header: "Payer/Receiver", value: (r) => r.party },
  { header: "Paid via", value: (r) => r.paid_via },
  { header: "Type", value: (r) => r.type },
  { header: "Creation time", value: (r) => istStamp(r.created_at) },
  { header: "Transaction ID", value: (r) => r.txn_id, ref: true },
  { header: "Amount", value: (r) => money(r.amount) },
  { header: "Processing fee", value: (r) => money(r.fee) },
  { header: "Net amount", value: (r) => money(r.net) },
  { header: "Status", value: (r) => r.status },
  { header: "Update time", value: (r) => istStamp(r.updated_at) },
  { header: "Notes", value: (r) => r.notes },
  { header: "RRN/UTR", value: (r) => r.rrn, ref: true },
  { header: "Banker code", value: (r) => r.banker_code },
  { header: "Order ID", value: (r) => r.order_id, ref: true },
  { header: "Source", value: (r) => CHANNEL_LABELS[r.channel] },
];

/** `Katana_Statement_20260803-20260809.csv` — period in the name, as GPay's export does. */
export function statementFilename(range: StatementRange, channel: StatementChannel): string {
  const tag = channel === "ALL" ? "" : channel === "VPA" ? "_Gateway" : "_MerchantHosted";
  return `Katana_Statement${tag}_${range.slug}.csv`;
}
