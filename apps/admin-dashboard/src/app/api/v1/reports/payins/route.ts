// POST /api/v1/reports/payins — a merchant's own pay-in report for a date range, authenticated
// by its Key + Salt (allow-listed in middleware).
//
//   body: { key, from, to, format?, hash }     hash over: from|to
//
//   from, to   calendar days in India, YYYY-MM-DD, at most 31 days
//   format     json (default) or csv
//
// A Key only sees orders of its own mode. The answer carries X-Report-Hash, the SHA-256 of the
// report's content; the JSON repeats it as `report_hash`.
import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { authPayoutRequest, parseMerchantBody } from "@/lib/payout-api";
import { merchantSafeBody } from "@/lib/merchant-safe";
import { payinReport, reportCsv, reportHash, validateReportRange } from "@/lib/payin-report";

export const dynamic = "force-dynamic";

const schema = z.object({
  key: z.string().min(1),
  hash: z.string().min(1),
  from: z.string().min(1).max(10),
  to: z.string().min(1).max(10),
  format: z.enum(["json", "csv"]).default("json"),
});

export async function POST(req: Request) {
  let body;
  try { body = schema.parse(await parseMerchantBody(req)); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  const bad = validateReportRange(body.from, body.to);
  if (bad) return NextResponse.json({ error: bad }, { status: 400 });
  try {
    const auth = await authPayoutRequest(body.key, body.hash, [body.from, body.to]);
    if (!auth.ok) return NextResponse.json({ error: auth.error, code: auth.code }, { status: auth.status });

    const report = await payinReport(auth.merchantCode, auth.livemode, body.from, body.to);
    if (body.format === "csv") {
      const csv = reportCsv(report);
      return new NextResponse("﻿" + csv, { headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="payins-${body.from}-to-${body.to}.csv"`,
        "cache-control": "no-store", "x-report-hash": reportHash(csv),
        ...(report.truncated ? { "x-report-truncated": "true" } : {}),
      } });
    }
    const safe = merchantSafeBody(report as unknown as Record<string, unknown>, "api/v1/reports/payins");
    const hash = reportHash(JSON.stringify(safe));
    return NextResponse.json({ ...safe, report_hash: hash }, { headers: { "cache-control": "no-store", "x-report-hash": hash } });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
