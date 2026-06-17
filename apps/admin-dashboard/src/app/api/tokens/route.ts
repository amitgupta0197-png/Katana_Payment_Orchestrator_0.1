// GET  /api/tokens — list saved payment tokens (scoped per persona).
// POST /api/tokens — create a token (typically called by adapter integration;
//                    here exposed for sandbox/demo writes).

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { gateOrResponse, resolveProviderMerchants } from "@/lib/scope";
import { createToken, listTokens } from "@/lib/token-vault";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN","PROVIDER","MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const url = new URL(req.url);
  const customerRef = url.searchParams.get("customer_ref") ?? undefined;
  const merchantQuery = url.searchParams.get("merchant_id") ?? undefined;

  try {
    if (s.persona === "MERCHANT") {
      const tokens = await listTokens({ merchantId: s.scope_id!, customerRef });
      return NextResponse.json({ tokens });
    }
    if (s.persona === "PROVIDER") {
      const ids = await resolveProviderMerchants(s);
      if (!ids.length) return NextResponse.json({ tokens: [] });
      const all = await Promise.all(ids.map((mid: string) => listTokens({ merchantId: mid })));
      return NextResponse.json({ tokens: all.flat() });
    }
    return NextResponse.json({ tokens: await listTokens({ merchantId: merchantQuery, customerRef }) });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const schema = z.object({
  customer_ref:  z.string().min(1),
  provider:      z.string().min(1),
  provider_token: z.string().min(1),
  network_token_id: z.string().optional(),
  method: z.enum(["CARD","UPI","WALLET"]),
  brand: z.string().optional(),
  last4: z.string().regex(/^\d{2,4}$/).optional(),
  exp_month: z.number().int().min(1).max(12).optional(),
  exp_year: z.number().int().min(2020).max(2099).optional(),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN","MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const merchantId = s.persona === "MERCHANT" ? s.scope_id! : "tenant-default";
    const r = await createToken({
      customerRef: body.customer_ref, merchantId,
      provider: body.provider, providerTokenRaw: body.provider_token,
      networkTokenId: body.network_token_id, method: body.method,
      brand: body.brand, last4: body.last4,
      expMonth: body.exp_month, expYear: body.exp_year,
    });
    return NextResponse.json(r);
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
