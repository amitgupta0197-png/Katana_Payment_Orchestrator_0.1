// SUPER_ADMIN CRUD; Provider/Merchant blocked.
// Roles are derived from persona_kind + scope per PRODUCT_VISION §1.1.

import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

const ROLES = [
  { code: "SUPER_ADMIN", scope: "platform-wide", permissions: ["*"], description: "Katana operator — full visibility, approval authority." },
  { code: "PROVIDER_OWNER", scope: "provider", permissions: ["merchant.read","merchant.kyc.upload","merchant.create","sub_mid.request"], description: "Merchant admin — onboards bankers, requests Sub-MIDs." },
  { code: "PROVIDER_OPERATOR", scope: "provider", permissions: ["merchant.read","merchant.read","sub_mid.read"], description: "Merchant day-to-day ops." },
  { code: "PROVIDER_READER", scope: "provider", permissions: ["merchant.read","merchant.read"], description: "Merchant read-only." },
  { code: "MERCHANT_OWNER", scope: "merchant", permissions: ["merchant.read","api_key.issue","webhook.config"], description: "Banker admin — manages keys + webhooks." },
  { code: "MERCHANT_OPERATOR", scope: "merchant", permissions: ["merchant.read","checkout.create"], description: "Banker operational." },
  { code: "MERCHANT_READER", scope: "merchant", permissions: ["merchant.read"], description: "Banker read-only." },
];

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  return NextResponse.json({ roles: ROLES });
}
