// POST /api/v1/reports/paytm-import — ingest a Paytm for Business "Payment Statement" CSV.
//
// WHY THIS EXISTS. On-device capture reads the RRN off Paytm's screen, which only works while
// that screen can be driven: the phone awake, the list scrollable, the layout unchanged. When
// any of that fails the payment is not merely late, it is INVISIBLE — the agent counts only what
// it saw, so nothing in Katana can tell you a payment was missed. On 2026-08-21 Paytm held 268
// payments for AVTS23 and Katana held 108, and no counter anywhere showed the other 160.
//
// The merchant's own statement is the fix and the audit trail at once. Paytm generates it from
// its ledger (Reports -> Payment History & Reports), it carries an RRN for EVERY row, and it is
// the independent source of truth the capture path has never had. Importing it both recovers the
// backlog and, run daily, measures the real capture rate.
//
// The rows go through ingestTxnAlert — the SAME reconciler the agent feeds — so an imported
// credit is matched, deduped and audited exactly like a captured one. Nothing here writes to
// vendor_txn_alerts directly; a second ingestion path would be a second set of bugs.
//
// Re-importing the same day is safe and expected: ingestTxnAlert dedupes CREDITs on a 12-digit
// RRN, so rows already captured come back DUPLICATE (a benign re-scrape) rather than doubling
// the day's takings. That is what makes this runnable on a schedule.

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { ingestTxnAlert } from "@/lib/txn-reconcile";

export const dynamic = "force-dynamic";
// A trading day of rows, each one an ingest with its own matching queries.
export const maxDuration = 300;

/** Paytm wraps most values as "'…'" — a CSV-quoted single-quoted string. Strip both layers. */
function clean(v: string | undefined): string {
  return (v ?? "").trim().replace(/^'+|'+$/g, "").trim();
}

/**
 * RFC4180 CSV -> array of row objects. Written out rather than pulled from a dependency because
 * the statement is a plain, well-formed export and the parse must not become a supply-chain
 * question on a route that ingests money.
 */
function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  // Strip a UTF-8 BOM: Excel-friendly exports carry one and it would corrupt the first header.
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
      continue;
    }
    field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);

  const header = (rows.shift() ?? []).map((h) => h.trim());
  return rows.map((r) => {
    const o: Record<string, string> = {};
    header.forEach((h, i) => { o[h] = r[i] ?? ""; });
    return o;
  });
}

/**
 * "2026-08-21 15:18:02" -> "2026-08-21T15:18:02+05:30".
 *
 * The statement states IST wall-clock with no offset, and the server runs UTC. Read as UTC every
 * payment would land 5h30m early — evening payments would move into the previous day and match
 * against the wrong orders. India has no DST, so the fixed offset is exact.
 */
function istToIso(v: string): string | undefined {
  const m = clean(v).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+05:30` : undefined;
}

export async function POST(req: Request) {
  // TWO WAYS IN, because this route has two callers with different natures.
  //
  //   • A person, importing a statement they just downloaded — an admin session, as everywhere.
  //   • The nightly job, which has no session and must not have one. It presents the same
  //     x-cron-key the other scheduled routes use (see api/v1/cron/*), so the daily
  //     reconciliation can run unattended. That job is the whole point: a statement imported
  //     once by hand fixes one day, a statement imported every night makes missing a payment
  //     impossible to sustain.
  //
  // The key is checked FIRST and, when valid, skips the session gate entirely — cron has no
  // cookies to present. An absent or wrong key simply falls through to the session check, so a
  // browser request is never weakened by this.
  const cronKey = process.env.FIFO_CRON_KEY;
  const presented = req.headers.get("x-cron-key");
  const viaCron = !!cronKey && presented === cronKey;
  if (!viaCron) {
    const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "FINANCE"]);
    if ("response" in g) return g.response;
  }

  const url = new URL(req.url);
  const merchantId = (url.searchParams.get("merchant_id") ?? "").trim();
  if (!merchantId) {
    return NextResponse.json({ error: "merchant_id is required (the banker code the credits belong to)" }, { status: 400 });
  }
  // A dry run parses and reports exactly what a real import would do, without ingesting. The
  // first thing anyone wants to know about a statement is whether it was read correctly.
  const dryRun = url.searchParams.get("dry_run") === "1";

  let csv: string;
  const ctype = req.headers.get("content-type") ?? "";
  try {
    if (ctype.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return NextResponse.json({ error: "no file field in form data" }, { status: 400 });
      csv = await file.text();
    } else {
      csv = await req.text();
    }
  } catch {
    return NextResponse.json({ error: "could not read the request body" }, { status: 400 });
  }
  if (!csv.trim()) return NextResponse.json({ error: "empty body" }, { status: 400 });

  let parsed: Array<Record<string, string>>;
  try { parsed = parseCsv(csv); } catch { return NextResponse.json({ error: "could not parse the CSV" }, { status: 400 }); }
  if (!parsed.length) return NextResponse.json({ error: "no data rows" }, { status: 400 });
  if (!("RRN" in parsed[0]) || !("Amount" in parsed[0])) {
    return NextResponse.json(
      { error: "this does not look like a Paytm Payment Statement (no RRN / Amount column)", columns: Object.keys(parsed[0]).slice(0, 12) },
      { status: 400 },
    );
  }

  const counts: Record<string, number> = {};
  const skipped: Array<{ row: number; why: string }> = [];
  let ingested = 0;

  for (let i = 0; i < parsed.length; i++) {
    const r = parsed[i];
    const status = clean(r.Status).toUpperCase();
    const type = clean(r.Transaction_Type).toUpperCase();
    const rrn = clean(r.RRN);
    const amount = Number(clean(r.Amount));

    // ACQUIRING = money taken from a customer. Refunds and settlements share this file and are
    // NOT collections; letting them through would inflate the day and match against live orders.
    if (status !== "SUCCESS") { skipped.push({ row: i + 2, why: `status ${status || "(blank)"}` }); continue; }
    if (type && type !== "ACQUIRING") { skipped.push({ row: i + 2, why: `type ${type}` }); continue; }
    if (!Number.isFinite(amount) || amount <= 0) { skipped.push({ row: i + 2, why: "no usable amount" }); continue; }
    // The RRN is what makes a row dedupable against an already-captured credit. Without one an
    // import would insert a fresh copy of a payment the agent already has, every single run.
    if (!/^\d{12}$/.test(rrn)) { skipped.push({ row: i + 2, why: `RRN not 12 digits (${rrn || "blank"})` }); continue; }

    if (dryRun) { counts.DRY_RUN = (counts.DRY_RUN ?? 0) + 1; ingested++; continue; }

    try {
      const res = await ingestTxnAlert({
        source: "PAYTM_REPORT",
        merchant_id: merchantId,
        bank: "PAYTM",
        direction: "CREDIT",
        amount,
        utr: rrn,
        payer_vpa: clean(r.Customer_VPA) || undefined,
        payer_name: clean(r.Customer_Nickname) || undefined,
        event_time: istToIso(r.Transaction_Date),
        parser_version: "paytm-statement-1.0",
        narration: `Paytm statement import · ${clean(r.Payment_Mode) || "UPI"}`,
        raw: `PAYTM_STATEMENT RRN=${rrn} TXN=${clean(r.Transaction_ID)} AMT=${amount}`,
        details: {
          transaction_id: clean(r.Transaction_ID),
          order_id: clean(r.Order_ID),
          payment_mode: clean(r.Payment_Mode),
          // The batch UTR the payment settles under — NOT the per-payment reference. Kept for
          // settlement reconciliation; `utr` above is the RRN, as everywhere else in Katana.
          settlement_utr: clean(r["UTR_No."]),
          pos_id: clean(r.POS_ID),
          mid: clean(r.MID),
          paid_at_ist: clean(r.Transaction_Date),
        },
      }, { channelTrusted: true });
      counts[res.outcome] = (counts[res.outcome] ?? 0) + 1;
      ingested++;
    } catch (err) {
      const e = pgError(err);
      skipped.push({ row: i + 2, why: `ingest failed: ${e.body?.error ?? "unknown"}` });
    }
  }

  return NextResponse.json({
    ok: true,
    dry_run: dryRun,
    merchant_id: merchantId,
    rows_in_file: parsed.length,
    ingested,
    outcomes: counts,
    skipped_count: skipped.length,
    // Truncated: a bad file skips every row and the response should stay readable.
    skipped: skipped.slice(0, 25),
  });
}
