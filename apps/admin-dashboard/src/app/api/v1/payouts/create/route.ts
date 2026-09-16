// POST /api/v1/payouts/create — merchant server creates a payout, authenticated by the
// merchant's Key + Salt (allow-listed in middleware).
//
//   hash over: txnid|amount|beneficiary|rail|purpose
//              (beneficiary = the beneficiary_ref or beneficiary_id sent)
//
// Idempotent on txnid: a timeout is not a failure. Retry with the SAME txnid, or ask
// /api/v1/payouts/status; a second txnid is a second payout.
//
// The key decides test or live. A test key only pays out through PayU UAT, so it never moves
// real money. The result arrives as a signed payout.status callback (notify_url, else the
// merchant's webhook URL).
import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { toMinor } from "@/lib/money";
import { createPayout } from "@/lib/fifo-payout";
import { authPayoutRequest, parseMerchantBody, payoutView, PAYOUT_VIEW_COLS } from "@/lib/payout-api";

export const dynamic = "force-dynamic";

const schema = z.object({
  key: z.string().min(1),
  hash: z.string().min(1),
  txnid: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, "txnid: 1-40 letters, digits, _ or -"),
  // Signed exactly as sent, so it stays a string. Paise at most.
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/, "amount: rupees as a string, e.g. \"1500\" or \"1500.50\""),
  beneficiary_ref: z.string().min(1).max(40).optional(),
  beneficiary_id: z.string().uuid().optional(),
  rail: z.enum(["IMPS", "NEFT", "RTGS", "UPI"]).optional(),
  purpose: z.string().max(50).optional(),
  currency: z.literal("INR").default("INR"),
  // http(s) only; SSRF is additionally blocked at delivery by safeFetch.
  notify_url: z.string().url().refine((u) => /^https?:\/\//i.test(u), "notify_url must be http(s)").optional(),
}).refine((b) => !!b.beneficiary_ref !== !!b.beneficiary_id, "send exactly one of beneficiary_ref or beneficiary_id");

export async function POST(req: Request) {
  let body;
  try { body = schema.parse(await parseMerchantBody(req)); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  try {
    const beneficiary = body.beneficiary_ref ?? body.beneficiary_id!;
    const auth = await authPayoutRequest(body.key, body.hash, [body.txnid, body.amount, beneficiary, body.rail, body.purpose]);
    if (!auth.ok) return NextResponse.json({ error: auth.error, code: auth.code }, { status: auth.status });

    let beneficiaryId = body.beneficiary_id;
    if (body.beneficiary_ref) {
      beneficiaryId = (await rows<{ id: string }>("fifo",
        `SELECT id::text FROM fifo_beneficiaries WHERE merchant_id=$1 AND merchant_ref=$2`,
        [auth.merchantCode, body.beneficiary_ref]))[0]?.id;
      if (!beneficiaryId) return NextResponse.json({ error: `no beneficiary with beneficiary_ref ${body.beneficiary_ref}` }, { status: 404 });
    }

    const amountMinor = toMinor(body.amount, "INR");
    if (amountMinor <= 0n) return NextResponse.json({ error: "amount must be more than 0" }, { status: 400 });

    const r = await createPayout({
      merchantId: auth.merchantCode, beneficiaryId: beneficiaryId!, amountMinor, currency: "INR",
      purpose: body.purpose, rail: body.rail, merchantTxnId: body.txnid,
      livemode: auth.livemode, callbackUrl: body.notify_url, actor: `api:${body.key}`,
    });
    if (r.error) return NextResponse.json({ error: r.error }, { status: r.status ?? 400 });

    const row = (await rows<any>("fifo", `SELECT ${PAYOUT_VIEW_COLS} FROM fifo_orders WHERE id=$1::uuid`, [r.order.id]))[0];
    const reused = !!r.order.idempotent;
    return NextResponse.json({
      payout: payoutView(row),
      reused,
      approval_required: row.status === "HOLD",
    }, { status: reused ? 200 : 201 });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
