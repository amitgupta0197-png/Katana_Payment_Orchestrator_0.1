// /api/me/integration — the logged-in BRANCH's own integration profile for the
// developer page: checkout key + scheme (salt hidden), configured webhook/return
// URLs, and the orchestrator endpoint URLs. POST regenerates the Key + Salt
// (salt returned ONCE).
//   MERCHANT only (own).

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { issueCheckoutCreds, getCheckoutCredsStatus, ISSUED_CHECKOUT_SCHEMES } from "@/lib/merchant-checkout";
import { ownMerchantCode } from "@/lib/merchant-keys";
import { activationErrorResponse } from "@/lib/live-activation";
import { merchantSafeScheme } from "@/lib/merchant-safe";

export const dynamic = "force-dynamic";

const BASE = (process.env.PUBLIC_BASE_URL ?? "https://katanapay.co").replace(/\/$/, "");

function endpoints() {
  return {
    base_url: BASE,
    create_order: `${BASE}/api/v1/katana-pay/order`,
    pay_page: `${BASE}/pay/{order_id}`,
    status_enquiry: `${BASE}/api/pay-status/{order_id}`,
  };
}

// The older scheme's stored id names a gateway; a merchant is shown the neutral id (lib/merchant-safe).
function safeScheme<T>(v: T): T {
  if (v && typeof v === "object" && "scheme" in v) return { ...v, scheme: merchantSafeScheme((v as { scheme?: string }).scheme) };
  return v;
}

export async function GET() {
  const g = await gateOrResponse(["MERCHANT"]);
  if ("response" in g) return g.response;
  const code = await ownMerchantCode(g.session.scope_id);
  if (!code) return NextResponse.json({ error: "merchant not resolved" }, { status: 404 });
  try {
    const [status, testStatus] = await Promise.all([
      getCheckoutCredsStatus(code, true), getCheckoutCredsStatus(code, false),
    ]);
    // Defensive: tolerate an older schema without these columns (degrades to blank).
    const m = (await rows<any>("merchant",
      `SELECT COALESCE(webhook_url,'') AS webhook_url, COALESCE(return_url,'') AS return_url FROM merchants WHERE merchant_code = $1`, [code]).catch(() => []))[0] ?? {};
    return NextResponse.json({
      merchant_code: code,
      // { configured, key, scheme, salt_hint }; the scheme id is the merchant-facing one.
      credentials: safeScheme(status),
      test_credentials: safeScheme(testStatus),
      webhook_url: m.webhook_url ?? "",
      return_url: m.return_url ?? "",
      endpoints: endpoints(),
      schemes: ISSUED_CHECKOUT_SCHEMES,
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const schema = z.object({
  scheme: z.enum(ISSUED_CHECKOUT_SCHEMES).default("HMAC_SHA256"),
  livemode: z.boolean().default(true),   // which pair to (re)generate; the other is untouched
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["MERCHANT"]);
  if ("response" in g) return g.response;
  const code = await ownMerchantCode(g.session.scope_id);
  if (!code) return NextResponse.json({ error: "merchant not resolved" }, { status: 404 });
  let body;
  try { body = schema.parse(await req.json().catch(() => ({}))); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const creds = await issueCheckoutCreds(code, body.scheme, body.livemode); // key + salt ONCE
    return NextResponse.json({ creds: safeScheme(creds), livemode: body.livemode }, { status: 201 });
  } catch (err) {
    const a = activationErrorResponse(err);   // a live pair before live mode is activated
    if (a) return NextResponse.json(a.body, { status: a.status });
    const e = pgError(err); return NextResponse.json(e.body, { status: e.status });
  }
}
