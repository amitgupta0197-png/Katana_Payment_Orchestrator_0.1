// /api/me/integration — the logged-in BRANCH's own integration profile for the
// developer page: checkout key + scheme (salt hidden), configured webhook/return
// URLs, and the orchestrator endpoint URLs. POST regenerates the Key + Salt
// (salt returned ONCE).
//   MERCHANT only (own).

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { issueCheckoutCreds, getCheckoutCredsStatus } from "@/lib/merchant-checkout";
import { SIGNING_SCHEMES } from "@/lib/gateway-creds";

export const dynamic = "force-dynamic";

const BASE = (process.env.PUBLIC_BASE_URL ?? "https://glhouse.shop").replace(/\/$/, "");

async function ownMerchantCode(scopeId: string | null): Promise<string | null> {
  if (!scopeId) return null;
  // A MERCHANT session's scope_id IS the cross-service merchant_code (varchar) — the
  // same identity /api/merchants and the checkout vault key on. Normalize via the
  // merchants table when a row exists; otherwise use scope_id directly so issue +
  // read stay consistent (demo/seed personas have no merchants row).
  const r = await rows<{ merchant_code: string }>(
    "merchant", `SELECT merchant_code FROM merchants WHERE merchant_code = $1 OR id::text = $1 LIMIT 1`, [scopeId],
  ).catch(() => []);
  return r[0]?.merchant_code ?? scopeId;
}

function endpoints() {
  return {
    base_url: BASE,
    create_order: `${BASE}/api/v1/katana-pay/order`,
    pay_page: `${BASE}/pay/{order_id}`,
    status_enquiry: `${BASE}/api/pay-status/{order_id}`,
  };
}

export async function GET() {
  const g = await gateOrResponse(["MERCHANT"]);
  if ("response" in g) return g.response;
  const code = await ownMerchantCode(g.session.scope_id);
  if (!code) return NextResponse.json({ error: "merchant not resolved" }, { status: 404 });
  try {
    const status = await getCheckoutCredsStatus(code);
    // Defensive: tolerate an older schema without these columns (degrades to blank).
    const m = (await rows<any>("merchant",
      `SELECT COALESCE(webhook_url,'') AS webhook_url, COALESCE(return_url,'') AS return_url FROM merchants WHERE merchant_code = $1`, [code]).catch(() => []))[0] ?? {};
    return NextResponse.json({
      merchant_code: code,
      credentials: status,                  // { configured, key, scheme, salt_hint }
      webhook_url: m.webhook_url ?? "",
      return_url: m.return_url ?? "",
      endpoints: endpoints(),
      schemes: SIGNING_SCHEMES,
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const schema = z.object({ scheme: z.enum(["PAYU_SHA512", "HMAC_SHA256"]).default("HMAC_SHA256") });

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
    const creds = await issueCheckoutCreds(code, body.scheme); // returns key + salt ONCE
    return NextResponse.json({ creds }, { status: 201 });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
