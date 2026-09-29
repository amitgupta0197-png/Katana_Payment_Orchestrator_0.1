// POST /api/pay/status — what happened to an order a merchant created with POST /api/pay.
// Authenticated by the merchant's Katana Key + Salt (allow-listed in middleware), like /api/pay.
//
// The customer's browser comes back to the merchant's surl/furl with ?txnid=&status=, and that
// query string is not signed. A merchant marks an order paid only on this call's answer, the way
// a PayU merchant calls verify_payment.
//
// Request (JSON or form): { key, txnid, hash }
//   PAYU_SHA512: sha512(key|verify_payment|txnid|salt)      (PayU's verify_payment hash)
//   HMAC_SHA256: HMAC-SHA256(key+salt, "status|" + txnid)
// Answer: { txnid, status: SUCCESS | FAILED | PENDING, amount, currency, livemode,
//           payment_id, bank_ref }
//
// A test key sees only test orders and a live key only live ones. While the order is still open
// Katana first asks the gateway, so the answer is as fresh as the gateway's.

import { createHash, createHmac, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { resolveCheckoutKey, getCheckoutCreds, type CheckoutCreds } from "@/lib/merchant-checkout";
import { checkGatewayPayin, gatewayPayinFor } from "@/lib/gateway-payin";

export const dynamic = "force-dynamic";

const schema = z.object({
  key: z.string().min(1),
  txnid: z.string().min(1).max(120),
  hash: z.string().min(1),
});

async function parseBody(req: Request): Promise<Record<string, unknown>> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return await req.json();
  const fd = await req.formData();
  const out: Record<string, unknown> = {};
  for (const [k, v] of fd.entries()) out[k] = typeof v === "string" ? v : undefined;
  return out;
}

function statusSignature(c: CheckoutCreds, txnid: string): string {
  return c.scheme === "HMAC_SHA256"
    ? createHmac("sha256", `${c.key}${c.salt}`).update(`status|${txnid}`).digest("hex")
    : createHash("sha512").update(`${c.key}|verify_payment|${txnid}|${c.salt}`).digest("hex");
}

function hexEqual(a: string, b: string): boolean {
  try {
    const x = Buffer.from(a, "hex"), y = Buffer.from(b.toLowerCase(), "hex");
    return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
  } catch { return false; }
}

interface OrderRow {
  id: string; txn_id: string; status: string; amount_minor: string; currency: string; livemode: boolean;
}

async function load(merchantCode: string, txnid: string, livemode: boolean): Promise<OrderRow | null> {
  return (await rows<OrderRow>("checkout", `
    SELECT id::text, txn_id, status, amount_minor::text, currency, livemode
      FROM checkout_orders WHERE merchant_id = $1 AND txn_id = $2 AND livemode = $3 LIMIT 1
  `, [merchantCode, txnid, livemode]))[0] ?? null;
}

const FINAL = new Set(["SUCCESS", "FAILED"]);

export async function POST(req: Request) {
  let body;
  try { body = schema.parse(await parseBody(req)); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const resolved = await resolveCheckoutKey(body.key);
    if (!resolved) return NextResponse.json({ error: "invalid key" }, { status: 401 });
    const { merchantCode, livemode } = resolved;
    const creds = await getCheckoutCreds(merchantCode, livemode);
    if (!creds || creds.key !== body.key) return NextResponse.json({ error: "invalid key" }, { status: 401 });
    if (!hexEqual(statusSignature(creds, body.txnid), body.hash))
      return NextResponse.json({ error: "signature mismatch" }, { status: 401 });

    let o = await load(merchantCode, body.txnid, livemode);
    if (!o) return NextResponse.json({ error: "order not found", txnid: body.txnid }, { status: 404 });

    if (!FINAL.has(o.status)) {
      const gw = await gatewayPayinFor(merchantCode);
      if (gw) {
        await checkGatewayPayin({ provider: gw.connector.id, txnid: o.txn_id, merchantCode, source: "merchant_status" }).catch(() => null);
        o = (await load(merchantCode, body.txnid, livemode)) ?? o;
      }
    }

    const d = (await rows<{ provider_payment_id: string | null; bank_ref_num: string | null }>("checkout",
      `SELECT provider_payment_id, bank_ref_num FROM payment_details WHERE order_id = $1::uuid`, [o.id]).catch(() => []))[0];
    const minor = BigInt(o.amount_minor);
    return NextResponse.json({
      txnid: o.txn_id,
      status: FINAL.has(o.status) ? o.status : "PENDING",
      amount: `${minor / 100n}.${(minor % 100n).toString().padStart(2, "0")}`,
      currency: o.currency,
      livemode: o.livemode,
      payment_id: d?.provider_payment_id ?? null,
      bank_ref: d?.bank_ref_num ?? null,
    });
  } catch (err) {
    const e = pgError(err); return NextResponse.json(e.body, { status: e.status });
  }
}
