// POST /api/v1/bank-feeds/{bank_code}?merchant_id=M10001[&dry_run=1] — take a bank statement
// (MT940 or camt.053, lib/bank-statement) and hand its credits to the reconciler.
//
// WHAT IT IS FOR. A statement is the bank's own record of the account. Imported, it is the
// independent check on the capture path: a credit the phone or the mailbox never saw is
// recorded here, and one they did see comes back DUPLICATE. Like the Paytm statement import
// it goes through ingestTxnAlert, so there is one reconciler and one set of rules.
//
// WHAT IT DOES NOT DO. It never marks an order paid by itself. A statement line carries a date,
// not the moment of payment, and the reconciler matches amounts against the orders of the last
// half hour — so a line from this morning could sit beside an unrelated order created just
// now. The credits are therefore sent as BANK_STATEMENT, a source the reconciler does not
// auto-confirm: a line that looks like an order's payment becomes a case for a person.
//
// THREE WAYS IN:
//   • a person uploading a file they downloaded — an admin session (SUPER_ADMIN, ADMIN, FINANCE)
//   • a scheduled job — the x-cron-key the other jobs use
//   • the bank pushing it — x-timestamp and x-signature = HMAC-SHA256(secret, timestamp + "." + body),
//     where the secret is BANK_FEED_SECRET_<BANK_CODE>. Off until that secret is set.
//
// Body: the statement itself, or multipart form data with a `file` field.

import { createHmac, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { ingestTxnAlert } from "@/lib/txn-reconcile";
import { balances, parseStatement } from "@/lib/bank-statement";
import { recordSecurityEvent } from "@/lib/security-event";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const eq = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** How the caller proved itself, or null. `raw` is the exact body a bank signed. */
function machineAuth(req: Request, bankCode: string, raw: string): "cron" | "bank" | "bad-signature" | null {
  const cronKey = process.env.FIFO_CRON_KEY;
  const presented = req.headers.get("x-cron-key");
  if (cronKey && presented && eq(presented, cronKey)) return "cron";
  const sig = req.headers.get("x-signature");
  if (!sig) return null;
  const secret = process.env[`BANK_FEED_SECRET_${bankCode}`];
  const ts = req.headers.get("x-timestamp") ?? "";
  if (!secret || !/^\d{10,13}$/.test(ts)) return "bad-signature";
  const sent = Number(ts.length === 13 ? ts : ts + "000");
  if (Math.abs(Date.now() - sent) > 300_000) return "bad-signature";                 // five minutes either way
  const want = createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex");
  return eq(sig.toLowerCase(), want) ? "bank" : "bad-signature";
}

export async function POST(req: Request, { params }: { params: Promise<{ bank_code: string }> }) {
  const bankCode = (await params).bank_code.toUpperCase();
  if (!/^[A-Z0-9_]{2,20}$/.test(bankCode)) return NextResponse.json({ error: "bank code is letters and digits" }, { status: 400 });

  const ctype = req.headers.get("content-type") ?? "";
  let text: string;
  try {
    if (ctype.includes("multipart/form-data")) {
      const file = (await req.formData()).get("file");
      if (!(file instanceof File)) return NextResponse.json({ error: "no file field in form data" }, { status: 400 });
      text = await file.text();
    } else text = await req.text();
  } catch { return NextResponse.json({ error: "could not read the request body" }, { status: 400 }); }

  const machine = machineAuth(req, bankCode, text);
  if (machine === "bad-signature") {
    await recordSecurityEvent({ risk: "BAD_SIGNATURE", detail: `bank feed for ${bankCode}` });
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let actor: string = machine ?? "";
  if (!machine) {
    const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "FINANCE"]);
    if ("response" in g) return g.response;
    actor = g.session.email;
  }

  const url = new URL(req.url);
  const merchantId = (url.searchParams.get("merchant_id") ?? "").trim();
  if (!merchantId) return NextResponse.json({ error: "merchant_id is required (the banker whose account this statement is for)" }, { status: 400 });
  const dryRun = url.searchParams.get("dry_run") === "1";
  if (!text.trim()) return NextResponse.json({ error: "empty body" }, { status: 400 });

  const s = parseStatement(text);
  if ("error" in s) return NextResponse.json({ error: s.error }, { status: 400 });
  // A statement whose entries do not account for its own balances was cut short or misread.
  // Nothing is imported from it: half a statement is worse than none.
  const adds = balances(s);
  if (adds === false)
    return NextResponse.json({ error: "the entries do not add up to the statement's closing balance; nothing was imported", problems: s.problems.slice(0, 25) }, { status: 422 });

  const outcomes: Record<string, number> = {};
  const skipped: { entry: number; why: string }[] = [];
  let ingested = 0;
  for (let i = 0; i < s.entries.length; i++) {
    const e = s.entries[i];
    if (e.direction !== "CREDIT") { skipped.push({ entry: i + 1, why: "debit" }); continue; }
    if (e.reversal) { skipped.push({ entry: i + 1, why: "reversal of an earlier debit" }); continue; }
    if (!(e.amount > 0)) { skipped.push({ entry: i + 1, why: "no usable amount" }); continue; }
    // The reference is what lets a statement line be recognised as a credit already captured.
    // Without one every import would add the same payment again.
    if (!e.rrn) { skipped.push({ entry: i + 1, why: "no single 12-digit reference" }); continue; }
    if (dryRun) { outcomes.DRY_RUN = (outcomes.DRY_RUN ?? 0) + 1; ingested++; continue; }
    try {
      const r = await ingestTxnAlert({
        source: "BANK_STATEMENT", merchant_id: merchantId, bank: bankCode, direction: "CREDIT",
        amount: e.amount, utr: e.rrn,
        payer_vpa: e.payerVpa ?? undefined, payer_name: e.payerName ?? undefined,
        event_time: e.time ?? undefined,
        parser_version: `${s.format.toLowerCase()}-1.0`,
        narration: `${bankCode} statement · ${e.narration}`.slice(0, 300),
        raw: `BANK_STATEMENT ${bankCode} RRN=${e.rrn} AMT=${e.amount} DATE=${e.date}`,
        details: {
          format: s.format, account: s.account ?? "", value_date: e.date,
          bank_ref: e.bankRef ?? "", customer_ref: e.customerRef ?? "", imported_by: actor,
        },
      }, { channelTrusted: true });
      outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
      ingested++;
    } catch (err) {
      skipped.push({ entry: i + 1, why: `ingest failed: ${pgError(err).body.error}` });
    }
  }

  return NextResponse.json({
    ok: true, dry_run: dryRun, bank: bankCode, merchant_id: merchantId, format: s.format,
    account: s.account, opening: s.opening, closing: s.closing, balanced: adds,
    entries_in_file: s.entries.length, ingested, outcomes,
    unreadable: s.problems.slice(0, 25),
    skipped_count: skipped.length, skipped: skipped.slice(0, 25),
  });
}
