// The date/status window shared by the provider transactions list and its CSV export.
//
// Both narrow the same union (checkout_orders + vendor_payin_orders) and MUST narrow it
// identically: a merchant who filters the screen to a day and then presses Download CSV is
// reconciling one against the other, and a file that quietly covers a different window is
// worse than no file. So the WHERE is built once, here, and both routes import it.
//
// A DATE MEANS AN IST CALENDAR DAY. The columns are timestamptz and the server process runs
// UTC, so the obvious `$1::timestamptz` reads "2026-08-26" as 05:30 IST — which files an
// 11pm payment under the wrong day and pushes the small hours of every morning into the day
// before. This matters here: the branch that prompted the filter took its only payment of
// 26 Aug at 11:02pm IST.
//
// The cast is fussier than it looks. `date AT TIME ZONE 'Asia/Kolkata'` does NOT do what it
// reads like — `date` coerces to timestamptz, so the expression CONVERTS UTC midnight into
// IST wall-clock and hands back a bare `timestamp` (2026-08-26 05:30), which then compares
// against a timestamptz column as 05:30 UTC. Going through `::timestamp` first makes it the
// intended direction — interpret this wall-clock date AS Asia/Kolkata — and yields a real
// timestamptz (2026-08-25 18:30+00 = midnight IST). Verified against prod, 2026-08-27.

/** Midnight IST at the start of the given YYYY-MM-DD, as a timestamptz. */
const IST_DAY_START = (p: string) => `(${p}::date)::timestamp AT TIME ZONE 'Asia/Kolkata'`;
/** Midnight IST at the START OF THE NEXT DAY — so a `to` date is inclusive of its own day. */
const IST_DAY_END = (p: string) => `(${p}::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'`;

export interface TxnWindow {
  /** Merchant codes to scope to, or null for an unscoped (SUPER_ADMIN) view. */
  codes: string[] | null;
  from: string | null;    // YYYY-MM-DD, inclusive, IST
  to: string | null;      // YYYY-MM-DD, inclusive, IST
  status: string | null;
  /** true = live orders (the default); false = the dashboard is switched to test. */
  livemode: boolean;
}

// Anything that is not a plain calendar date is dropped rather than passed to the cast:
// the value is already a bound parameter, so this is not about injection — it is about a
// typo in a query string returning a 500 from ::date instead of an unfiltered page.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const readDate = (v: string | null): string | null => (v && DATE_RE.test(v) ? v : null);

// `livemode` comes from the dashboard's Test / Live switch (lib/mode.ts), never from the URL, so
// a shared link cannot flip someone else's view into the other mode.
export function txnWindowFromUrl(url: URL, codes: string[] | null, livemode = true): TxnWindow {
  return {
    codes,
    livemode,
    from: readDate(url.searchParams.get("from")),
    to: readDate(url.searchParams.get("to")),
    status: url.searchParams.get("status"),
  };
}

/** True when the window actually narrows anything beyond the caller's own scoping. */
export function txnWindowIsNarrowed(w: TxnWindow): boolean {
  return !!(w.from || w.to || w.status);
}

/**
 * The two sources live in different databases with different column aliases, so each gets
 * its own WHERE built against its own prefix. Same filter values, same $n order — the
 * parameter array is returned alongside so the caller can pass it straight to rows().
 *
 * `extra` carries conditions that take no parameter and must hold whatever else is set —
 * the unscoped pay-in read needs `merchant_id IS NOT NULL` always, and appending it here
 * keeps it from being dropped the moment a date makes the WHERE non-empty.
 */
export function txnConditions(
  prefix: string,
  w: TxnWindow,
  extra: string[] = [],
): { where: string; args: unknown[] } {
  const args: unknown[] = [];
  const cond: string[] = [];
  if (w.codes) { args.push(w.codes); cond.push(`${prefix}merchant_id = ANY($${args.length}::text[])`); }
  if (w.from) { args.push(w.from); cond.push(`${prefix}created_at >= ${IST_DAY_START(`$${args.length}`)}`); }
  if (w.to) { args.push(w.to); cond.push(`${prefix}created_at < ${IST_DAY_END(`$${args.length}`)}`); }
  if (w.status) { args.push(w.status.toUpperCase()); cond.push(`${prefix}status = $${args.length}`); }
  // The mode ALWAYS applies: a list, a total or a CSV never mixes test and live orders.
  args.push(w.livemode); cond.push(`${prefix}livemode = $${args.length}`);
  cond.push(...extra);
  return { where: cond.length ? "WHERE " + cond.join(" AND ") : "", args };
}
