// POST /api/merchants/[id]/test-pay — in-dashboard test harness (SUPER_ADMIN /
// PROVIDER-mapped). Runs a payment for this merchant so an operator can verify
// the integration without any external checkout page. Secrets stay server-side.
//   redirect=false → runs the shared checkout pipeline, returns the JSON result.
//   redirect=true  → returns { payu_url, fields } for the browser to auto-submit
//                    to PayU's hosted page (uses the merchant's stored PayU creds).

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { resolveMerchantScope } from "@/lib/merchant-keys";
import { runCheckout } from "@/lib/checkout-core";
import { getGatewayMid } from "@/lib/gateway-creds";
import { payuFields, payuPaymentUrl } from "@/lib/payu";
import { toMinor, fromMinor } from "@/lib/money";

export const dynamic = "force-dynamic";

const schema = z.object({
  amount: z.union([z.number(), z.string()]).default("100.00"),
  productinfo: z.string().default("Test order"),
  firstname: z.string().default("Test"),
  email: z.string().default("buyer@example.com"),
  phone: z.string().default("9999999999"),
  method: z.string().default("UPI_INTENT"),
  currency: z.string().default("INR"),
  redirect: z.boolean().default(false),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  const scope = await resolveMerchantScope(id, g.session);
  if ("response" in scope) return scope.response;
  const merchantCode = scope.code;

  let body;
  try { body = schema.parse(await req.json().catch(() => ({}))); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  const amountStr = typeof body.amount === "number" ? body.amount.toString() : body.amount;
  const currency = body.currency.toUpperCase();

  try {
    if (body.redirect) {
      const gw = await getGatewayMid(merchantCode);
      if (!gw || gw.gateway !== "PAYU") {
        return NextResponse.json({ error: "PayU gateway credentials not configured for this merchant" }, { status: 400 });
      }
      const amountMinor = toMinor(amountStr, currency);
      const txnid = "TEST-" + Date.now();
      const base = (process.env.PUBLIC_BASE_URL ?? "https://katanapay.co").replace(/\/$/, "");
      const ret = `${base}/api/gateway/payu/return`;
      const result = `${base}/api/pay-result`;
      await rows("checkout", `
        INSERT INTO checkout_orders
          (tenant_id, merchant_id, client_ref, txn_id, amount, amount_minor, currency,
           method, status, idempotency_key, customer_email, client_surl, client_furl)
        VALUES ('tenant-default', $1, $2, $3, $4, $5, $6, $7, 'CREATED', $8, $9, $10, $10)
      `, [merchantCode, body.productinfo, txnid,
          Number(fromMinor(amountMinor, currency)), String(amountMinor), currency,
          body.method.toUpperCase(), txnid, body.email, result]).catch(() => {});
      const fields = payuFields(gw, {
        txnid, amount: amountStr, productinfo: body.productinfo,
        firstname: body.firstname, email: body.email, phone: body.phone,
        surl: ret, furl: ret,
      });
      return NextResponse.json({ mode: "redirect", payu_url: payuPaymentUrl(gw.env), fields });
    }

    const r = await runCheckout({
      merchantId: merchantCode, actorId: `test:${g.session.user_id}`,
      order: {
        client_ref: body.productinfo, amount: amountStr, currency,
        method: body.method.toUpperCase(),
        customer_email: /.+@.+\..+/.test(body.email) ? body.email : undefined,
        idempotency_key: "TEST-" + Date.now(),
      },
    });
    return NextResponse.json({ mode: "simulated", ...r.body }, { status: r.httpStatus });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
