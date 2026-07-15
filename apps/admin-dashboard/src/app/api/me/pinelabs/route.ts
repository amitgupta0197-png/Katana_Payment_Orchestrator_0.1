// GET/POST /api/me/pinelabs — a MERCHANT manages its own Pine Labs (Plural) API keys so
// Katana can pull its transactions + RRN. Scoped to the caller's own merchant_code.
// Secret is write-only: GET never returns it, only secret_set.

import { NextResponse } from "next/server";
import { z } from "zod";
import { gateOrResponse } from "@/lib/scope";
import { getPinelabsConfig, savePinelabsConfig, resolveMerchantCode } from "@/lib/pinelabs";

export const dynamic = "force-dynamic";

const schema = z.object({
  enabled: z.boolean().optional(),
  env: z.enum(["SANDBOX", "PROD"]).optional(),
  client_id: z.string().trim().max(200).optional(),
  pinelabs_merchant_id: z.string().trim().max(120).optional(),
  client_secret: z.string().max(500).optional(),
});

export async function GET() {
  const g = await gateOrResponse(["MERCHANT"]);
  if ("response" in g) return g.response;
  if (!g.session.scope_id) return NextResponse.json({ error: "no merchant scope" }, { status: 400 });
  const code = await resolveMerchantCode(g.session.scope_id);
  return NextResponse.json(await getPinelabsConfig(code));
}

export async function POST(req: Request) {
  const g = await gateOrResponse(["MERCHANT"]);
  if ("response" in g) return g.response;
  if (!g.session.scope_id) return NextResponse.json({ error: "no merchant scope" }, { status: 400 });
  let body; try { body = schema.parse(await req.json()); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  const code = await resolveMerchantCode(g.session.scope_id);
  await savePinelabsConfig(code, body, g.session.email);
  return NextResponse.json({ ok: true, ...(await getPinelabsConfig(code)) });
}
