// GET/POST /api/merchants/{id}/pinelabs — admin manages a branch's Pine Labs (Plural) API
// keys so Katana can pull that merchant's transactions + RRN. {id} may be the branch uuid
// or its merchant_code. Secret is write-only (GET returns secret_set, never the value).

import { NextResponse } from "next/server";
import { z } from "zod";
import { gateOrResponse } from "@/lib/scope";
import { getPinelabsConfig, savePinelabsConfig, resolveMerchantCode } from "@/lib/pinelabs";

export const dynamic = "force-dynamic";
const ROLES = ["SUPER_ADMIN", "ADMIN"] as const;

const schema = z.object({
  enabled: z.boolean().optional(),
  env: z.enum(["SANDBOX", "PROD"]).optional(),
  client_id: z.string().trim().max(200).optional(),
  pinelabs_merchant_id: z.string().trim().max(120).optional(),
  client_secret: z.string().max(500).optional(),
});

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse([...ROLES]);
  if ("response" in g) return g.response;
  const { id } = await params;
  const code = await resolveMerchantCode(id);
  return NextResponse.json(await getPinelabsConfig(code));
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse([...ROLES]);
  if ("response" in g) return g.response;
  const { id } = await params;
  let body; try { body = schema.parse(await req.json()); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  const code = await resolveMerchantCode(id);
  await savePinelabsConfig(code, body, g.session.email);
  return NextResponse.json({ ok: true, ...(await getPinelabsConfig(code)) });
}
