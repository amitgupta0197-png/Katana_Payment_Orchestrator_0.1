// Katana-issued checkout integration credentials for a merchant.
//   GET  /api/merchants/[id]/checkout-key   — non-secret status (key + salt hint).
//   POST /api/merchants/[id]/checkout-key   — generate/rotate; returns Key + Salt ONCE.
//
// SUPER_ADMIN any; PROVIDER only for mapped merchants (resolveMerchantScope).
// The merchant puts the returned Key + Salt into their checkout integration.

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { resolveMerchantScope } from "@/lib/merchant-keys";
import { issueCheckoutCreds, getCheckoutCredsStatus } from "@/lib/merchant-checkout";
import { SIGNING_SCHEMES } from "@/lib/gateway-creds";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  const scope = await resolveMerchantScope(id, g.session);
  if ("response" in scope) return scope.response;
  try {
    return NextResponse.json({ status: await getCheckoutCredsStatus(scope.code) });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const schema = z.object({ scheme: z.enum(["PAYU_SHA512", "HMAC_SHA256"]).default("PAYU_SHA512") });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  const scope = await resolveMerchantScope(id, g.session);
  if ("response" in scope) return scope.response;

  let body;
  try { body = schema.parse(await req.json().catch(() => ({}))); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  if (!SIGNING_SCHEMES.includes(body.scheme)) {
    return NextResponse.json({ error: "unsupported signing scheme" }, { status: 400 });
  }

  try {
    const creds = await issueCheckoutCreds(scope.code, body.scheme);
    // Key + Salt returned ONCE for the merchant to configure their checkout.
    return NextResponse.json({ creds }, { status: 201 });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
