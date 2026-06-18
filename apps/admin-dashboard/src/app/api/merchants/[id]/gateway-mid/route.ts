// Gateway Main-MID credentials for a merchant (internal mapping).
//   GET  /api/merchants/[id]/gateway-mid   — non-secret status (no key/salt).
//   POST /api/merchants/[id]/gateway-mid   — store/rotate the gateway Key + Salt.
//
// SUPER_ADMIN only: these are the gateway's (PayU/Airpay) MID secrets, which
// Katana holds on the merchant's behalf and never exposes. Stored sealed in the
// credential vault; consumed at order time by /api/checkout.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { storeGatewayMid, getGatewayMidStatus, SIGNING_SCHEMES } from "@/lib/gateway-creds";

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
  gateway: z.string().min(1).max(40),
  mid_code: z.string().min(1).max(80),
  key: z.string().min(1).max(2048),
  salt: z.string().min(1).max(2048),
  scheme: z.enum(["PAYU_SHA512", "HMAC_SHA256"]),
});

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
  if (!SIGNING_SCHEMES.includes(body.scheme)) {
    return NextResponse.json({ error: "unsupported signing scheme" }, { status: 400 });
  }

  try {
    await storeGatewayMid(code, {
      gateway: body.gateway.toUpperCase(), mid_code: body.mid_code,
      key: body.key, salt: body.salt, scheme: body.scheme,
    });
    // Echo only non-secret status back.
    return NextResponse.json({ status: await getGatewayMidStatus(code) }, { status: 201 });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
