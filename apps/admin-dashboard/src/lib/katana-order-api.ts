// The Katana pay-in order API, shared by its three endpoints:
//
//   POST /api/v1/katana-pay/order   the general API: the merchant's selected flow decides
//   POST /api/v1/p2p/order          the P2P API: a UPI link to the banker's own UPI ID
//   POST /api/v1/intent/order       the Intent API: a gateway takes the payment
//
// All three take the same request, verify the same Key + Salt signature and answer with the
// same fields, so an integration written against one works against the others. The only
// difference is the flow: the P2P and Intent APIs ask for theirs by name and are refused
// (409, code FLOW_NOT_ENABLED / FLOW_NOT_SELECTED) for a merchant not on that flow.
//
// Signature (the same scheme as /api/pay):
//   HMAC_SHA256: HMAC-SHA256(key+salt, txnid|amount|productinfo|email)
//   PAYU_SHA512: sha512(key|txnid|amount|productinfo|firstname|email|udf1..5||||||salt)   (older pairs)
//
// Refusals a merchant can act on carry a `code`: the flow codes above, LIVE_MODE_NOT_ACTIVATED,
// MERCHANT_BLOCKED / MERCHANT_SUSPENDED / PAYIN_NOT_ENABLED (403), and the limit codes of lib/payin-limits — 422
// with `field`, `limit` and `actual`, or 429 RATE_LIMITED with a Retry-After header.
//
// Every answer carries an X-Request-Id header: the caller's own when it sent one, else one made
// here. It is kept on the order and in its status history, so one id follows the payment.

import { describeOrderRequestError, signingRuleFor } from "@/lib/order-request-errors";
import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { resolveCheckoutKey, getCheckoutCreds, verifyCheckoutSignature } from "@/lib/merchant-checkout";
import { createKatanaOrder, MerchantBlockedError, OrderRefTakenError, PayinFlowError, PayinSetupError } from "@/lib/katana-order";
import type { OrderFlow } from "@/lib/payin-flow";
import { activationErrorResponse } from "@/lib/live-activation";
import { PayuIntentError, intentClientFrom } from "@/lib/payu-intent";
import { merchantSafeBody, merchantSafeError } from "@/lib/merchant-safe";
import { PayinLimitError, payinLimitBody } from "@/lib/payin-limits";
import { NoMidAvailableError } from "@/lib/mid-switch";
import { AccountNotLiveError } from "@/lib/gateway-golive";
import { logApiRequest } from "@/lib/api-log";
import { bankerLiveCheckoutMode } from "@/lib/checkout-mode-store";
import { clientIp } from "@/lib/session-security";

const schema = z.object({
  key: z.string().min(1),
  txnid: z.string().min(1).max(60),
  amount: z.union([z.number().positive(), z.string().min(1)]),
  hash: z.string().min(1),
  productinfo: z.string().optional(),
  firstname: z.string().optional(),          // customer name (also part of the PAYU signature)
  email: z.string().optional(),
  phone: z.string().optional(),              // customer phone
  customer_vpa: z.string().optional(),       // sender / payer VPA
  receiver_vpa: z.string().optional(),       // single receiver VPA
  receiver_vpas: z.array(z.string()).max(30).optional(), // receiver VPA pool (backup failover)
  mode: z.enum(["QR", "INTENT"]).optional(),
  currency: z.string().optional(),
  // The PAYING CUSTOMER's IP and user-agent. Required by PayU when the merchant is paid through
  // PayU; this request's own headers belong to the merchant's server.
  client_ip: z.string().max(64).optional(),
  device_info: z.string().max(512).optional(),
  // Restrict to http(s) so a stored return_url/notify_url can't carry javascript:/data:/file:
  // (open-redirect / scheme abuse — audit M8). SSRF on notify_url is additionally blocked at
  // egress by safeFetch.
  return_url: z.string().url().refine((u) => /^https?:\/\//i.test(u), "return_url must be http(s)").optional(),
  notify_url: z.string().url().refine((u) => /^https?:\/\//i.test(u), "notify_url must be http(s)").optional(),
});

async function parseBody(req: Request): Promise<Record<string, unknown>> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return await req.json();
  const fd = await req.formData();
  const out: Record<string, unknown> = {};
  for (const [k, v] of fd.entries()) out[k] = typeof v === "string" ? v : undefined;
  return out;
}

export interface KatanaOrderApi {
  /** The flow this endpoint is for: the P2P API, the Intent API, or null for the general one. */
  flow: OrderFlow | null;
  /** Where a scrubbed error is logged from (lib/merchant-safe). */
  where: string;
}

/** The caller's X-Request-Id when it is a plain token, else a new id. */
export function requestIdFrom(req: Request): string {
  const sent = req.headers.get("x-request-id")?.trim() ?? "";
  return /^[A-Za-z0-9._:-]{8,64}$/.test(sent) ? sent : randomUUID();
}

export async function katanaOrderPost(req: Request, api: KatanaOrderApi): Promise<NextResponse> {
  const requestId = requestIdFrom(req);
  const started = Date.now();
  const seen: Seen = { merchant: null, livemode: null, body: null };
  const res = await handle(req, api, requestId, seen);
  res.headers.set("x-request-id", requestId);
  // The request log (lib/api-log) reads a copy of the answer; the answer itself is untouched.
  const answer = await res.clone().json().catch(() => null);
  logApiRequest({
    requestId, merchantId: seen.merchant, livemode: seen.livemode, apiVersion: "v1", method: "POST",
    endpoint: `/${api.where}`, httpStatus: res.status, latencyMs: Date.now() - started,
    errorCode: res.status >= 400 ? (answer?.code ?? null) : null, requestBody: seen.body, responseBody: answer, ip: clientIp(req),
  });
  return res;
}

/** What the request log needs from a request, filled in as far as the request got. */
interface Seen { merchant: string | null; livemode: boolean | null; body: unknown }

async function handle(req: Request, api: KatanaOrderApi, requestId: string, seen: Seen): Promise<NextResponse> {
  const WHERE = api.where;
  let raw: Record<string, unknown>;
  try { raw = await parseBody(req); } catch {
    return NextResponse.json({ error: "invalid request: send a JSON or form body", code: "INVALID_REQUEST", missing: [], invalid: [], hints: [] }, { status: 400 });
  }
  seen.body = raw;
  const parsed = schema.safeParse(raw);
  // Says which fields are missing or wrong, and names a field sent under another gateway's name.
  if (!parsed.success) return NextResponse.json(describeOrderRequestError(raw, parsed.error), { status: 400 });
  const body = parsed.data;
  const amountStr = typeof body.amount === "number" ? body.amount.toString() : body.amount;

  try {
    // 1. key -> merchant + mode. The key's prefix decides the mode (mk_test_ / mk_live_; a
    //    legacy mk_<hex> key is live) — never a field in the request.
    const resolved = await resolveCheckoutKey(body.key);
    if (!resolved) return NextResponse.json({ error: "invalid key" }, { status: 401 });
    const { merchantCode, livemode } = resolved;
    seen.merchant = merchantCode; seen.livemode = livemode;
    const creds = await getCheckoutCreds(merchantCode, livemode);
    if (!creds || creds.key !== body.key) return NextResponse.json({ error: "invalid key" }, { status: 401 });

    // 2. verify the merchant's signature over the order (same fields as /api/pay)
    const ok = verifyCheckoutSignature(creds, {
      txnId: body.txnid, amount: amountStr,
      productinfo: body.productinfo, firstname: body.firstname, email: body.email,
    }, body.hash);
    // The error text stays "signature mismatch" (merchants and the support assistant match on it);
    // the hint says what is signed, which is in the public guide and reveals no secret.
    if (!ok) return NextResponse.json({ error: "signature mismatch", code: "SIGNATURE_MISMATCH", hint: signingRuleFor(creds.scheme) }, { status: 401 });

    // 3. create the pay-in (idempotent on txnid) and return the deeplink response.
    const amount = Number(amountStr);
    if (!Number.isFinite(amount) || amount <= 0) return NextResponse.json({ error: "invalid amount" }, { status: 400 });

    const r = await createKatanaOrder({
      orderId: body.txnid,
      amount,
      currency: (body.currency ?? "INR").toUpperCase(),
      customerVpa: body.customer_vpa ?? null,
      receiverVpa: body.receiver_vpa ?? null,
      receiverVpas: body.receiver_vpas,
      mode: body.mode,
      customerPhone: body.phone ?? null,
      merchantId: merchantCode,
      livemode,                 // from the key; a test order pays the sandbox UPI ID
      returnUrl: body.return_url ?? null,
      notifyUrl: body.notify_url ?? null,
      client: intentClientFrom(req, { ip: body.client_ip, deviceInfo: body.device_info }),
      flow: api.flow,           // null: the merchant's selected flow decides
      requestId,
      routeAcrossBankers: true, // the merchant's banker switch may give it to another of its bankers
    });
    if (!r.order) return NextResponse.json({ error: "order create failed" }, { status: 500 });

    const base = (process.env.PUBLIC_BASE_URL ?? "https://katanapay.co").replace(/\/$/, "");
    // Merchants on a hosted-page gateway (PayU Client ID, RubyVault, iSmartPay) pay on that page.
    // pay_url is still Katana's page, which shows the order and hands over to the gateway;
    // gateway_url goes straight to the gateway's page — through Katana's own link
    // (/pay/{id}/go), because that page's address names the gateway and the gateway is never
    // named to the merchant (lib/merchant-safe).
    const hosted = !!r.checkoutUrl;
    // `checkout` says what this order carries (lib/pg-catalog CheckoutMode): H2H when it has a UPI
    // link for the merchant's own page, REDIRECT when the customer must go to pay_url. A hosted
    // order whose processor also gave a UPI link (PayAtom) is H2H too: the link is returned,
    // and gateway_url still opens the processor's page. A test order carries the sandbox UPI
    // link (H2H); `live_checkout` says what this banker's live orders will get.
    const h2h = !!r.upiIntent;
    const liveCheckout = livemode ? undefined : await bankerLiveCheckoutMode(r.banker ?? merchantCode);
    return NextResponse.json(merchantSafeBody({
      verified: true,
      // The banker that holds the order: the signer's, or another of the merchant's bankers when
      // the banker switch moved it (lib/banker-switch). `signed_by` is the Key's banker.
      merchant: r.banker ?? merchantCode,
      signed_by: merchantCode,
      livemode,
      reused: r.reused,
      // The flow the order took (P2P | INTENT). A test order pays the sandbox UPI ID whatever the flow.
      flow: r.order.channel_type ?? null,
      order: r.order,
      checkout: h2h ? "H2H" : "REDIRECT",
      ...(liveCheckout !== undefined ? { live_checkout: liveCheckout } : {}),
      deeplinks: h2h ? r.deeplinks : null,
      upi_intent: h2h ? r.upiIntent : null,
      qr_payload: h2h ? r.upiIntent : null,
      pay_url: `${base}/pay/${r.order.id}`,   // hand the customer's browser here
      ...(hosted ? { gateway_url: `${base}/pay/${r.order.id}/go` } : {}),
    }, WHERE), { status: r.reused ? 200 : 201 });
  } catch (err) {
    if (err instanceof MerchantBlockedError) return NextResponse.json({ error: err.message, code: err.code }, { status: 403 });
    if (err instanceof OrderRefTakenError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    // A limit refused the order: which one, on which field, and the limit itself.
    if (err instanceof PayinLimitError)
      return NextResponse.json(payinLimitBody(err.breach), {
        status: err.status, headers: err.status === 429 ? { "retry-after": "1" } : undefined,
      });
    // The merchant's flow does not allow this order: say which rule, so an integration can tell
    // "not enabled for you" from a payment failure.
    if (err instanceof PayinFlowError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    if (err instanceof AccountNotLiveError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    // Every MID the banker's switch has is used up, paused or outside its hours (lib/mid-switch).
    if (err instanceof NoMidAvailableError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status, headers: { "retry-after": "60" } });
    if (err instanceof PayuIntentError || err instanceof PayinSetupError) return NextResponse.json({ error: merchantSafeError(err.message, WHERE) }, { status: err.status });
    const a = activationErrorResponse(err);   // live key, live mode not activated
    if (a) return NextResponse.json(a.body, { status: a.status });
    const e = pgError(err); return NextResponse.json(e.body, { status: e.status });
  }
}
