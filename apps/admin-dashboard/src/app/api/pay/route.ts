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
import { rows, pgError } from "@/lib/pg";
import { toMinor, fromMinor } from "@/lib/money";
import { resolveCheckoutKey, getCheckoutCreds, verifyCheckoutSignature } from "@/lib/merchant-checkout";
import { getGatewayMid, payuKeySalt } from "@/lib/gateway-creds";
import { payuAutoSubmitForm } from "@/lib/payu";
import { issuePayuIntent, intentClientFrom } from "@/lib/payu-intent";
import { merchantSafeBody } from "@/lib/merchant-safe";
import { getMerchantFlow } from "@/lib/payin-flow-store";
import { serviceRefusal } from "@/lib/merchant-services-store";
import { issueGatewayIntent, startGatewayCheckout } from "@/lib/gateway-payin";
import { intentGatewayPayinFor } from "@/lib/payin-providers";
import { runCheckout } from "@/lib/checkout-core";
import { assertLiveActivated, activationErrorResponse } from "@/lib/live-activation";
import { goLiveBlocker } from "@/lib/gateway-golive";
import { logApiRequest } from "@/lib/api-log";
import { requestIdFrom } from "@/lib/katana-order-api";
import { clientIp } from "@/lib/session-security";

// Everything this route answers goes to a merchant, so no gateway is ever named (lib/merchant-safe).
const json = (body: Record<string, unknown> | undefined, init?: ResponseInit) =>
  NextResponse.json(body && merchantSafeBody(body, "api/pay"), init);

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
  phone: z.string().optional(),
  currency: z.string().optional(),
  method: z.string().optional(),
  // Hosted-gateway redirect: when truthy, Katana returns an auto-submit form to
  // the gateway's (PayU) hosted page instead of running the simulated pipeline.
  redirect: z.union([z.string(), z.boolean()]).optional(),
  // UPI intent (PayU S2S): when truthy, Katana asks PayU for the UPI intent and returns
  // app deep links as JSON — no PayU page. client_ip / device_info are the PAYING
  // CUSTOMER's IP and user-agent (PayU requires them); the request's own headers are the
  // merchant server's, so pass them.
  intent: z.union([z.string(), z.boolean()]).optional(),
  client_ip: z.string().max(64).optional(),
  device_info: z.string().max(512).optional(),
  surl: z.string().optional(),   // merchant success URL (Katana forwards here after the gateway callback)
  furl: z.string().optional(),   // merchant failure URL
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

/** What the request log needs from a request, filled in as far as the request got. */
interface Seen { merchant: string | null; livemode: boolean | null; body: unknown }

export async function POST(req: Request) {
  const started = Date.now();
  const requestId = requestIdFrom(req);
  const seen: Seen = { merchant: null, livemode: null, body: null };
  const res = await handle(req, seen);
  // The request log (lib/api-log) reads a copy of the answer; the answer itself is untouched.
  // A hosted-page answer is HTML, not JSON, and is logged without a body.
  const answer = (res.headers.get("content-type") ?? "").includes("json") ? await res.clone().json().catch(() => null) : null;
  logApiRequest({
    requestId, merchantId: seen.merchant, livemode: seen.livemode, apiVersion: "v1", method: "POST", endpoint: "/api/pay",
    httpStatus: res.status, latencyMs: Date.now() - started, errorCode: res.status >= 400 ? (answer?.code ?? null) : null,
    requestBody: seen.body, responseBody: answer, ip: clientIp(req),
  });
  return res;
}

async function handle(req: Request, seen: Seen): Promise<NextResponse> {
  let body;
  try {
    const raw = await parseBody(req);
    seen.body = raw;
    body = schema.parse(raw);
  } catch (e) {
    return json({ error: (e as Error).message }, { status: 400 });
  }

  const amountStr = typeof body.amount === "number" ? body.amount.toString() : body.amount;

  try {
    // 1. key -> merchant + mode (the key's prefix decides; a legacy mk_<hex> key is live)
    const resolved = await resolveCheckoutKey(body.key);
    if (!resolved) return json({ error: "invalid key" }, { status: 401 });
    const { merchantCode, livemode } = resolved;
    seen.merchant = merchantCode; seen.livemode = livemode;

    const creds = await getCheckoutCreds(merchantCode, livemode);
    if (!creds || creds.key !== body.key) {
      return json({ error: "invalid key" }, { status: 401 });
    }

    // 2. verify the merchant's signature over the order
    const ok = verifyCheckoutSignature(creds, {
      txnId: body.txnid, amount: amountStr,
      productinfo: body.productinfo, firstname: body.firstname, email: body.email,
    }, body.hash);
    if (!ok) return json({ error: "signature mismatch" }, { status: 401 });

    // A live order — either branch below — needs live mode activated for this merchant.
    if (livemode) await assertLiveActivated(merchantCode);

    // A merchant onboarded for payouts only takes no pay-in on any branch below (lib/merchant-services).
    const off = await serviceRefusal(merchantCode, "PAYIN");
    if (off) return json(off, { status: 403 });

    // This is the gateway checkout: every payment it starts is taken by a gateway. A merchant
    // on the P2P flow (lib/payin-flow) is never sent to one, so it is pointed at the P2P API.
    if ((await getMerchantFlow(merchantCode)).flow === "P2P")
      return json({ error: "this merchant is on the P2P flow; create P2P orders with POST /api/v1/p2p/order", code: "FLOW_NOT_ENABLED" }, { status: 409 });

    // 2.5 Hosted-gateway redirect (real PayU): build a signed PayU request with
    //     the merchant's stored gateway Key+Salt and hand the customer's browser
    //     off to PayU's hosted page. PayU posts the result to our return endpoint.
    const wantRedirect = body.redirect === true || body.redirect === "true" || body.redirect === "1";
    const wantIntent = body.intent === true || body.intent === "true" || body.intent === "1";

    // Razorpay, Cashfree, CCAvenue, PhonePe and Paytm (lib/gateway-payin). Their sandbox keys
    // pair with a Katana test key, so these work for test orders too.
    const other = wantRedirect || wantIntent ? await intentGatewayPayinFor(merchantCode) : null;
    if (other) {
      const currency = (body.currency ?? "INR").toUpperCase();
      if (currency !== "INR") return json({ error: `${other.connector.name} payments are INR only here` }, { status: 400 });
      const input = {
        mid: other.mid, connector: other.connector, merchantCode, livemode,
        txnid: body.txnid, amount: amountStr, currency,
        method: (body.method ?? (wantIntent ? "UPI_INTENT" : "CARD")).toUpperCase(),
        productinfo: body.productinfo ?? "Order", firstname: body.firstname ?? "Customer",
        email: body.email ?? "", phone: body.phone ?? "9999999999",
        clientSurl: body.surl ?? null, clientFurl: body.furl ?? null,
        client: intentClientFrom(req, { ip: body.client_ip, deviceInfo: body.device_info }),
        actor: `merchant:${merchantCode}`,
      };
      if (wantIntent) {
        const r = await issueGatewayIntent(input);
        return json(r.httpStatus < 300 ? { verified: true, merchant: merchantCode, livemode, ...r.body } : r.body,
          { status: r.httpStatus });
      }
      const r = await startGatewayCheckout(input);
      if (r.html) return new NextResponse(r.html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
      return json(r.body, { status: r.httpStatus });
    }

    if (wantRedirect) {
      // The hosted redirect sends the customer to the real PayU page on the merchant's MID.
      // There is no separate test MID, so a test key cannot use it.
      if (!livemode)
        return json({ error: "test keys cannot use the hosted gateway redirect" }, { status: 400 });
      const gwMid = payuKeySalt(await getGatewayMid(merchantCode));
      if (!gwMid) {
        return json({ error: "no pay-in gateway is connected for this merchant" }, { status: 400 });
      }
      const currency = (body.currency ?? "INR").toUpperCase();
      const amountMinor = toMinor(amountStr, currency);
      // An account still on its go-live checklist takes only verification payments (lib/gateway-golive).
      const notLive = await goLiveBlocker(merchantCode, "PAYU", Number(amountStr));
      if (notLive) return json({ error: notLive, code: "ACCOUNT_NOT_LIVE" }, { status: 409 });

      // Create/track the order; PayU's callback finalises it. Store the merchant's
      // own success/failure URLs so the return handler can forward the customer.
      const existing = await rows<{ id: string }>("checkout",
        "SELECT id FROM checkout_orders WHERE idempotency_key = $1 LIMIT 1", [body.txnid]);
      if (!existing.length) {
        await rows("checkout", `
          INSERT INTO checkout_orders
            (tenant_id, merchant_id, client_ref, txn_id, amount, amount_minor, currency,
             method, status, idempotency_key, customer_email, client_surl, client_furl)
          VALUES ('tenant-default', $1, $2, $3, $4, $5, $6, $7, 'CREATED', $8, $9, $10, $11)
        `, [merchantCode, body.productinfo ?? body.txnid, body.txnid,
            Number(fromMinor(amountMinor, currency)), String(amountMinor), currency,
            (body.method ?? "CARD").toUpperCase(), body.txnid,
            body.email ?? null, body.surl ?? null, body.furl ?? null]).catch(() => {});
      }

      const base = (process.env.PUBLIC_BASE_URL ?? "https://katanapay.co").replace(/\/$/, "");
      const ret = `${base}/api/gateway/payu/return`;
      const html = payuAutoSubmitForm(gwMid, {
        txnid: body.txnid, amount: amountStr,
        productinfo: body.productinfo ?? "Order", firstname: body.firstname ?? "Customer",
        email: body.email ?? "", phone: body.phone ?? "9999999999",
        surl: ret, furl: ret,
      });
      return new NextResponse(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    }

    // 2.6 UPI intent (real PayU, S2S): Katana asks PayU for the intent on the merchant's MID
    //     and returns deep links for the customer's UPI apps. Confirmed later by the PayU
    //     webhook / verify sweep, like the hosted redirect.
    if (wantIntent) {
      // Same rule as the redirect: the intent is issued on the real MID, so a test key cannot use it.
      if (!livemode)
        return json({ error: "test keys cannot use the gateway UPI intent" }, { status: 400 });
      const gwMid = payuKeySalt(await getGatewayMid(merchantCode));
      if (!gwMid) {
        return json({ error: "no pay-in gateway is connected for this merchant" }, { status: 400 });
      }
      const currency = (body.currency ?? "INR").toUpperCase();
      if (currency !== "INR") return json({ error: "UPI intent supports INR only" }, { status: 400 });
      const notLive = await goLiveBlocker(merchantCode, "PAYU", Number(amountStr));
      if (notLive) return json({ error: notLive, code: "ACCOUNT_NOT_LIVE" }, { status: 409 });

      const r = await issuePayuIntent({
        mid: gwMid, merchantCode, livemode,
        txnid: body.txnid, amount: amountStr, currency,
        productinfo: body.productinfo ?? "Order", firstname: body.firstname ?? "Customer",
        email: body.email ?? "", phone: body.phone ?? "9999999999",
        clientSurl: body.surl ?? null, clientFurl: body.furl ?? null,
        client: intentClientFrom(req, { ip: body.client_ip, deviceInfo: body.device_info }),
        actor: `merchant:${merchantCode}`,
      });
      return json(r.httpStatus < 300 ? { verified: true, merchant: merchantCode, livemode, ...r.body } : r.body,
        { status: r.httpStatus });
    }

    // 3. map to the checkout pipeline. method must be one Katana supports.
    const method = (body.method ?? "UPI_INTENT").toUpperCase();
    if (!ALLOWED_METHODS.includes(method)) {
      return json({ error: `unsupported method '${method}'`, allowed: ALLOWED_METHODS }, { status: 400 });
    }

    const r = await runCheckout({
      merchantId: merchantCode,
      actorId: `merchant:${merchantCode}`,
      livemode,   // from the key; a test order writes nothing to the ledger
      order: {
        client_ref: body.productinfo?.slice(0, 120) || body.txnid,
        amount: amountStr,
        currency: (body.currency ?? "INR").toUpperCase(),
        method,
        customer_email: body.email && /.+@.+\..+/.test(body.email) ? body.email : undefined,
        idempotency_key: body.txnid,  // merchant txnid is the natural idempotency key
      },
    });
    return json({ verified: true, merchant: merchantCode, ...r.body }, { status: r.httpStatus });
  } catch (err) {
    const a = activationErrorResponse(err);
    if (a) return json(a.body, { status: a.status });
    const e = pgError(err); return json(e.body, { status: e.status });
  }
}
