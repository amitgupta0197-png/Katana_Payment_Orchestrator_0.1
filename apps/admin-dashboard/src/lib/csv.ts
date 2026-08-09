// CSV export helpers.
//
// Exports are opened in Excel by people reconciling money, which makes two things
// non-negotiable: a value containing a comma, quote or newline must not shift the
// columns, and a long numeric reference (UTR, RRN, account number) must not be
// "helpfully" reformatted into scientific notation. Both are handled here so no
// export route has to remember.

/** RFC-4180 escaping. */
export function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Long digit strings are references, not quantities. Excel turns a 16-digit UTR into
 * 1.23457E+15 and silently loses the last digits — an unusable reconciliation file.
 * Quoting alone does not stop it; the leading tab does.
 */
export function csvRef(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  const s = String(v);
  return /^\d{12,}$/.test(s) ? `"\t${s}"` : csvEscape(s);
}

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => unknown;
  /** Render as a reference rather than a number (see csvRef). */
  ref?: boolean;
}

export function toCsv<T>(columns: CsvColumn<T>[], rows: T[]): string {
  const head = columns.map((c) => csvEscape(c.header)).join(",");
  const body = rows.map((r) => columns.map((c) => (c.ref ? csvRef(c.value(r)) : csvEscape(c.value(r)))).join(","));
  return [head, ...body].join("\r\n");
}

/**
 * A CSV download. The BOM makes Excel read it as UTF-8 — without it, a merchant name
 * with an accent or a ₹ sign arrives as mojibake.
 */
export function csvResponse(filename: string, csv: string): Response {
  return new Response("﻿" + csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}

/** `transactions-2026-08-10.csv` — dated so repeated downloads do not overwrite. */
export function datedFilename(base: string): string {
  return `${base}-${new Date().toISOString().slice(0, 10)}.csv`;
}
