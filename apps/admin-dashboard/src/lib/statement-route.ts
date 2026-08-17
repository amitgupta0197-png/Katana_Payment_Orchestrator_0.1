// The statement endpoint's body, shared by the three portals.
//
// Each portal's route resolves its own persona to a code list and calls this; nothing
// here decides who may see what. `codes: null` means unrestricted and must only come
// from an admin-gated route.

import { NextResponse } from "next/server";
import { pgError } from "./pg";
import { toCsv, csvResponse } from "./csv";
import { fetchStatementRows } from "./statement-data";
import { hasRrn } from "./credit-verification";
import {
  resolvePeriod, statementFilename, STATEMENT_COLUMNS,
  type StatementChannel, type StatementPeriod,
} from "./statement";

const PERIODS: StatementPeriod[] = ["today", "yesterday", "last_week", "last_month", "last_fy", "custom"];
const CHANNELS: StatementChannel[] = ["ALL", "CHECKOUT", "VPA"];

/**
 * Build the statement for this request.
 *
 * `?preview=1` returns a JSON summary (row count and totals) so the screen can show what a
 * download would contain before the file is written; anything else returns the CSV itself.
 */
export async function statementResponse(req: Request, codes: string[] | null): Promise<Response> {
  const url = new URL(req.url);
  const p = url.searchParams.get("period") as StatementPeriod | null;
  const c = url.searchParams.get("channel") as StatementChannel | null;
  const period: StatementPeriod = p && PERIODS.includes(p) ? p : "yesterday";
  const channel: StatementChannel = c && CHANNELS.includes(c) ? c : "ALL";
  const range = resolvePeriod(period, url.searchParams.get("from"), url.searchParams.get("to"));

  try {
    const rows = await fetchStatementRows({ channel, range, codes });

    if (url.searchParams.get("preview")) {
      // A VPA credit with no 12-digit RRN is money the UPI network has not corroborated yet, so
      // it is quoted separately from the period's totals rather than inside them — the same rule
      // the portals apply. It IS still written to the file: a statement lists everything that
      // happened, and the Status/RRN columns say which rows are which.
      const unproven = (r: (typeof rows)[number]) =>
        r.channel === "VPA" && !hasRrn(r.rrn) && r.status !== "CONFIRMED";
      const counted = rows.filter((r) => !unproven(r));
      const awaiting = rows.filter(unproven);
      const sum = (list: typeof rows, f: (r: (typeof rows)[number]) => number) =>
        +list.reduce((a, r) => a + f(r), 0).toFixed(2);
      return NextResponse.json({
        period, channel, label: range.label,
        from: range.from.toISOString(), to: range.to.toISOString(),
        filename: statementFilename(range, channel),
        count: rows.length,
        // Proven money only. gross + awaiting_gross is every row in the file.
        gross: sum(counted, (r) => r.amount),
        fee: sum(counted, (r) => r.fee),
        net: sum(counted, (r) => r.net),
        awaiting_count: awaiting.length,
        awaiting_gross: sum(awaiting, (r) => r.amount),
        checkout_count: rows.filter((r) => r.channel === "CHECKOUT").length,
        vpa_count: rows.filter((r) => r.channel === "VPA").length,
      });
    }

    return csvResponse(statementFilename(range, channel), toCsv(STATEMENT_COLUMNS, rows));
  } catch (err) {
    const e = pgError(err);
    return NextResponse.json(e.body, { status: e.status });
  }
}
