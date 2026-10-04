// Katana-issued checkout integration credentials for a merchant.
//   GET  /api/merchants/[id]/checkout-key   — non-secret status (key + salt hint).
//   POST /api/merchants/[id]/checkout-key   — generate/rotate; returns Key + Salt ONCE.
//
// Generating and regenerating is for Super Admin and Admin (lib/key-access); a banker manages its
// own on the banker portal (/api/me/integration). A merchant (PROVIDER) may read its bankers' Keys,
// never the Salt or a hint of it, and cannot make or regenerate one.

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { resolveMerchantScope } from "@/lib/merchant-keys";
import { issueCheckoutCreds, getCheckoutCredsStatus, ISSUED_CHECKOUT_SCHEMES } from "@/lib/merchant-checkout";
import { activationErrorResponse } from "@/lib/live-activation";
import { merchantSafeScheme, seesGatewayNames } from "@/lib/merchant-safe";
import { KEY_ADMINS } from "@/lib/key-access";

export const dynamic = "force-dynamic";

// The older scheme's stored id names a gateway; a provider is shown the neutral id (lib/merchant-safe).
function safeScheme<T>(v: T): T {
  if (v && typeof v === "object" && "scheme" in v) return { ...v, scheme: merchantSafeScheme((v as { scheme?: string }).scheme) };
  return v;
}

/** What a merchant is shown of a pair: the Key and scheme, nothing of the Salt. */
function withoutSalt<T>(v: T): T {
  if (v && typeof v === "object" && "salt_hint" in v) { const { salt_hint: _s, ...rest } = v as Record<string, unknown>; return rest as T; }
  return v;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse([...KEY_ADMINS, "PROVIDER"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  const scope = await resolveMerchantScope(id, g.session);
  if ("response" in scope) return scope.response;
  try {
    const [status, testStatus] = await Promise.all([
      getCheckoutCredsStatus(scope.code, true), getCheckoutCredsStatus(scope.code, false),
    ]);
    const safe = seesGatewayNames(g.session.persona) ? <T,>(v: T) => v : <T,>(v: T) => withoutSalt(safeScheme(v));
    return NextResponse.json({ status: safe(status), test_status: safe(testStatus), can_manage: KEY_ADMINS.includes(g.session.persona) });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const schema = z.object({
  scheme: z.enum(ISSUED_CHECKOUT_SCHEMES).default("HMAC_SHA256"),
  livemode: z.boolean().default(true),   // which pair to (re)generate; the other is untouched
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse([...KEY_ADMINS, "PROVIDER"]);
  if ("response" in g) return g.response;
  if (g.session.persona === "PROVIDER")
    return NextResponse.json({ error: "Keys are made by the banker (banker portal → Integration) or by Katana admin", code: "KEYS_MANAGED_BY_BANKER" }, { status: 403 });
  const { id } = await params;
  const scope = await resolveMerchantScope(id, g.session);
  if ("response" in scope) return scope.response;

  let body;
  try { body = schema.parse(await req.json().catch(() => ({}))); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const creds = await issueCheckoutCreds(scope.code, body.scheme, body.livemode);
    // Key + Salt returned ONCE for the merchant to configure their checkout.
    return NextResponse.json({ creds: seesGatewayNames(g.session.persona) ? creds : safeScheme(creds), livemode: body.livemode }, { status: 201 });
  } catch (err) {
    const a = activationErrorResponse(err);   // a live pair before live mode is activated
    if (a) return NextResponse.json(a.body, { status: a.status });
    const e = pgError(err); return NextResponse.json(e.body, { status: e.status });
  }
}
