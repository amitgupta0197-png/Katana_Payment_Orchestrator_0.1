// Pay-in gateway credentials for a merchant (internal mapping).
//   GET  /api/merchants/[id]/gateway-mid   — non-secret status (no secrets).
//   POST /api/merchants/[id]/gateway-mid   — connect / rotate the merchant's pay-in gateway.
//        body: { gateway, env, fields: { … per lib/pg-catalog … } }
//
// SUPER_ADMIN only: these are the gateway's secrets, which Katana holds on the merchant's
// behalf and never exposes. Stored sealed in the credential vault. A merchant has ONE pay-in
// gateway; saving another replaces it. Changes are audited (never the secrets).

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { wormAppend } from "@/lib/worm";
import { storeGatewayMid, getGatewayMidStatus } from "@/lib/gateway-creds";
import { GATEWAYS, gatewayDef, validateCredFields } from "@/lib/pg-catalog";

export const dynamic = "force-dynamic";

async function merchantCode(id: string): Promise<string | null> {
  const m = await rows<{ merchant_code: string }>("merchant", `SELECT merchant_code FROM merchants WHERE id = $1::uuid`, [id]);
  return m[0]?.merchant_code ?? null;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  const code = await merchantCode(id);
  if (!code) return NextResponse.json({ error: "merchant not found" }, { status: 404 });
  try {
    return NextResponse.json({ status: await getGatewayMidStatus(code) });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const schema = z.object({
  gateway: z.enum(GATEWAYS.map((x) => x.id) as [string, ...string[]]),
  env: z.enum(["TEST", "PROD"]).default("TEST"),
  fields: z.record(z.string()).default({}),
});

// The built-in fields every gateway maps onto; everything else is kept as an extra.
const CORE = new Set(["mid_code", "key", "salt"]);

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  const code = await merchantCode(id);
  if (!code) return NextResponse.json({ error: "merchant not found" }, { status: 404 });

  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  const def = gatewayDef(body.gateway)!;
  const v = validateCredFields(def.payin, body.fields);
  if (!v.values) return NextResponse.json({ error: v.error }, { status: 400 });
  const f = v.values;
  // Razorpay keys say which mode they belong to; don't let a live key be saved as test.
  if (def.id === "RAZORPAY" && f.key.startsWith("rzp_live_") !== (body.env === "PROD"))
    return NextResponse.json({ error: "the Key ID's mode (rzp_test_ / rzp_live_) doesn't match the environment" }, { status: 400 });

  const extra = Object.fromEntries(Object.entries(f).filter(([k]) => !CORE.has(k)));
  try {
    const before = await getGatewayMidStatus(code);
    await storeGatewayMid(code, {
      gateway: def.id,
      mid_code: f.mid_code ?? f.key,
      key: f.key, salt: f.salt,
      // PayU signs with its SHA-512 hash; the others get their own signing in their connector.
      scheme: def.id === "PAYU" ? "PAYU_SHA512" : "HMAC_SHA256",
      env: body.env,
      extra: Object.keys(extra).length ? extra : undefined,
    });
    const after = await getGatewayMidStatus(code);
    await wormAppend({
      actorId: g.session.user_id, actorEmail: g.session.email,
      action: before.configured ? "merchant.payin_gateway.rotated" : "merchant.payin_gateway.set",
      resourceType: "merchant", resourceId: id, before, after: { merchant_code: code, ...after },
    }).catch(() => {});
    // Echo only non-secret status back.
    return NextResponse.json({ status: after }, { status: 201 });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
