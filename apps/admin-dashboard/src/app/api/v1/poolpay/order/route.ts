// POST /api/v1/poolpay/order — MERCHANT-facing PoolPay order creation,
// authenticated by the merchant's Katana checkout Key + Salt (NOT a session;
// allow-listed in middleware). This is the production path: a merchant's server
// signs and calls this to create a pay-in; the order lands in the cockpit queue
// where the operations team confirms it (UTR / screenshot / webhook).
//
// Signature is the SAME scheme merchants already use for /api/pay:
//   PAYU_SHA512: sha512(key|txnid|amount|productinfo|firstname|email|udf1..5||||||salt)
//   HMAC_SHA256: HMAC-SHA256(key+salt, txnid|amount|productinfo|email)

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { resolveMerchantByCheckoutKey, getCheckoutCreds, verifyCheckoutSignature } from "@/lib/merchant-checkout";
import { createPoolPayOrder } from "@/lib/poolpay-order";

export const dynamic = "force-dynamic";

const schema = z.object({
  key: z.string().min(1),
  txnid: z.string().min(1).max(60),
  amount: z.union([z.number().positive(), z.string().min(1)]),
  hash: z.string().min(1),
  productinfo: z.string().optional(),
  firstname: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  customer_vpa: z.string().optional(),
  currency: z.string().optional(),
});

async function parseBody(req: Request): Promise<Record<string, unknown>> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return await req.json();
  const fd = await req.formData();
  const out: Record<string, unknown> = {};
  for (const [k, v] of fd.entries()) out[k] = typeof v === "string" ? v : undefined;
  return out;
}

export async function POST(req: Request) {
  let body;
  try { body = schema.parse(await parseBody(req)); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  const amountStr = typeof body.amount === "number" ? body.amount.toString() : body.amount;

  try {
    // 1. key -> merchant
    const merchantCode = await resolveMerchantByCheckoutKey(body.key);
    if (!merchantCode) return NextResponse.json({ error: "invalid key" }, { status: 401 });
    const creds = await getCheckoutCreds(merchantCode);
    if (!creds || creds.key !== body.key) return NextResponse.json({ error: "invalid key" }, { status: 401 });

    // 2. verify the merchant's signature over the order (same fields as /api/pay)
    const ok = verifyCheckoutSignature(creds, {
      txnId: body.txnid, amount: amountStr,
      productinfo: body.productinfo, firstname: body.firstname, email: body.email,
    }, body.hash);
    if (!ok) return NextResponse.json({ error: "signature mismatch" }, { status: 401 });

    // 3. create the pay-in (idempotent on txnid) and return the deeplink response.
    const amount = Number(amountStr);
    if (!Number.isFinite(amount) || amount <= 0) return NextResponse.json({ error: "invalid amount" }, { status: 400 });

    const r = await createPoolPayOrder({
      orderId: body.txnid,
      amount,
      currency: (body.currency ?? "INR").toUpperCase(),
      customerVpa: body.customer_vpa ?? null,
      customerPhone: body.phone ?? null,
      merchantId: merchantCode,
    });
    if (!r.order) return NextResponse.json({ error: "order create failed" }, { status: 500 });

    const base = (process.env.PUBLIC_BASE_URL ?? "https://glhouse.shop").replace(/\/$/, "");
    return NextResponse.json({
      verified: true,
      merchant: merchantCode,
      reused: r.reused,
      order: r.order,
      deeplinks: r.deeplinks,
      upi_intent: r.upiIntent,
      qr_payload: r.upiIntent,
      pay_url: `${base}/pay/${r.order.id}`,   // hand the customer's browser here
    }, { status: r.reused ? 200 : 201 });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
