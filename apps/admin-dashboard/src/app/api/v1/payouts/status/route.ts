// POST /api/v1/payouts/status — merchant server asks for one payout's status, authenticated
// by the merchant's Key + Salt (allow-listed in middleware).
//
//   body: { key, txnid | payout_id, hash }      hash over: the txnid or payout_id sent
//
// A key only sees payouts of its own mode: a test key can't read live payouts.
import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { authPayoutRequest, parseMerchantBody, payoutView, PAYOUT_VIEW_COLS } from "@/lib/payout-api";

export const dynamic = "force-dynamic";

const schema = z.object({
  key: z.string().min(1),
  hash: z.string().min(1),
  txnid: z.string().min(1).max(40).optional(),
  payout_id: z.string().min(1).max(40).optional(),
}).refine((b) => !!b.txnid !== !!b.payout_id, "send exactly one of txnid or payout_id");

export async function POST(req: Request) {
  let body;
  try { body = schema.parse(await parseMerchantBody(req)); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const ref = body.txnid ?? body.payout_id!;
    const auth = await authPayoutRequest(body.key, body.hash, [ref]);
    if (!auth.ok) return NextResponse.json({ error: auth.error, code: auth.code }, { status: auth.status });

    const row = (await rows<any>("fifo", `
      SELECT ${PAYOUT_VIEW_COLS} FROM fifo_orders
       WHERE merchant_id=$1 AND direction='PAYOUT' AND livemode=$2
         AND ${body.txnid ? "merchant_txn_id=$3" : "order_ref=$3"}
    `, [auth.merchantCode, auth.livemode, ref]))[0];
    if (!row) return NextResponse.json({ error: "payout not found" }, { status: 404 });
    return NextResponse.json({ payout: payoutView(row) });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
