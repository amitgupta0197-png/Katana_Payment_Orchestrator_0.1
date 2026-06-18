// POST /api/pay — merchant-facing order creation, authenticated by the
// merchant's Katana Key + Salt (NOT a session cookie; allow-listed in middleware).
//
// Flow:
//   1. Merchant signs the order with the Katana-issued Key + Salt:
//        PAYU_SHA512: sha512(key|txnid|amount|productinfo|firstname|email|udf1..5||||||salt)
//        HMAC_SHA256: HMAC-SHA256(key+salt, txnid|amount|productinfo|email)
//   2. Katana resolves key -> merchant, verifies the hash with the stored salt.
//   3. Runs the shared checkout pipeline (lib/checkout-core), which internally
//      re-signs to the real gateway using the gateway MID key/salt.
//
// Accepts JSON or form-encoded bodies (PayU-style checkouts POST a form).

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { resolveMerchantByCheckoutKey, getCheckoutCreds, verifyCheckoutSignature } from "@/lib/merchant-checkout";
import { runCheckout } from "@/lib/checkout-core";

export const dynamic = "force-dynamic";

const ALLOWED_METHODS = ["UPI_INTENT","UPI_COLLECT","CARD","NETBANKING","WALLET","QR","CRYPTO"];

const schema = z.object({
  key: z.string().min(1),
  txnid: z.string().min(1).max(120),
  amount: z.union([z.number().positive(), z.string().min(1)]),
  hash: z.string().min(1),
  productinfo: z.string().optional(),
  firstname: z.string().optional(),
  email: z.string().optional(),
  currency: z.string().optional(),
  method: z.string().optional(),
});

async function parseBody(req: Request): Promise<Record<string, unknown>> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return await req.json();
  // form-encoded or multipart
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
    if (!creds || creds.key !== body.key) {
      return NextResponse.json({ error: "invalid key" }, { status: 401 });
    }

    // 2. verify the merchant's signature over the order
    const ok = verifyCheckoutSignature(creds, {
      txnId: body.txnid, amount: amountStr,
      productinfo: body.productinfo, firstname: body.firstname, email: body.email,
    }, body.hash);
    if (!ok) return NextResponse.json({ error: "signature mismatch" }, { status: 401 });

    // 3. map to the checkout pipeline. method must be one Katana supports.
    const method = (body.method ?? "UPI_INTENT").toUpperCase();
    if (!ALLOWED_METHODS.includes(method)) {
      return NextResponse.json({ error: `unsupported method '${method}'`, allowed: ALLOWED_METHODS }, { status: 400 });
    }

    const r = await runCheckout({
      merchantId: merchantCode,
      actorId: `merchant:${merchantCode}`,
      order: {
        client_ref: body.productinfo?.slice(0, 120) || body.txnid,
        amount: amountStr,
        currency: (body.currency ?? "INR").toUpperCase(),
        method,
        customer_email: body.email && /.+@.+\..+/.test(body.email) ? body.email : undefined,
        idempotency_key: body.txnid,  // merchant txnid is the natural idempotency key
      },
    });
    return NextResponse.json({ verified: true, merchant: merchantCode, ...r.body }, { status: r.httpStatus });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
