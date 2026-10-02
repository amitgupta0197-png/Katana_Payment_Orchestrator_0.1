// GET /api/portal/api-log — the API request log (lib/api-log).
//
// A merchant or banker session gets the summary of its own requests for the last 7 days: time,
// endpoint, status, latency. No bodies.
// Staff may add ?full=1 for the request and response bodies, with ?merchant=, ?from= and ?to=
// (YYYY-MM-DD) and ?format=csv to export.

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { PORTAL_PERSONAS, portalScope } from "@/lib/portal-scope";
import { readApiLog, MERCHANT_LOG_DAYS, type ApiLogRow } from "@/lib/api-log";
import { toCsv, csvResponse, datedFilename, type CsvColumn } from "@/lib/csv";

export const dynamic = "force-dynamic";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const COLUMNS: CsvColumn<ApiLogRow>[] = [
  { header: "time", value: (r) => new Date(r.created_at).toISOString() },
  // A caller chooses its own request id; one that starts like a formula is not handed to Excel as one.
  { header: "request_id", value: (r) => (/^[=+\-@]/.test(r.request_id) ? `'${r.request_id}` : r.request_id), ref: true },
  { header: "merchant", value: (r) => r.merchant_id ?? "", ref: true },
  { header: "mode", value: (r) => (r.livemode == null ? "" : r.livemode ? "live" : "test") },
  { header: "api", value: (r) => r.api_version },
  { header: "method", value: (r) => r.method },
  { header: "endpoint", value: (r) => r.endpoint },
  { header: "status", value: (r) => String(r.http_status) },
  { header: "latency_ms", value: (r) => String(r.latency_ms) },
  { header: "error_code", value: (r) => r.error_code ?? "" },
  { header: "ip", value: (r) => r.ip ?? "" },
  { header: "request_body", value: (r) => (r.request_body == null ? "" : JSON.stringify(r.request_body)) },
  { header: "response_body", value: (r) => (r.response_body == null ? "" : JSON.stringify(r.response_body)) },
];

export async function GET(req: Request) {
  const g = await gateOrResponse(PORTAL_PERSONAS);
  if ("response" in g) return g.response;
  const p = new URL(req.url).searchParams;
  try {
    const scope = await portalScope(g.session);
    if (scope.codes && !scope.codes.length) return NextResponse.json({ rows: [], days: MERCHANT_LOG_DAYS, full: false });
    // Bodies, ranges and the per-merchant filter are staff's; a merchant asking for them gets the summary.
    const full = scope.staff && p.get("full") === "1";
    const day = (k: string) => { const v = p.get(k) ?? ""; return DAY.test(v) ? v : null; };
    const status = p.get("status");
    const csv = full && p.get("format") === "csv";
    const log = await readApiLog({
      merchantCodes: scope.codes, full,
      merchant: scope.staff ? p.get("merchant")?.trim() || null : null,
      from: full ? day("from") : null, to: full ? day("to") : null,
      status: status === "ok" || status === "error" ? status : null,
      limit: csv ? 5_000 : Number(p.get("limit") ?? 200),
    });
    if (csv) return csvResponse(datedFilename("api-request-log"), toCsv(COLUMNS, log));
    return NextResponse.json({ rows: log, days: MERCHANT_LOG_DAYS, full });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
