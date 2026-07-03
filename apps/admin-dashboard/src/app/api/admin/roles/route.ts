// SUPER_ADMIN CRUD; Provider/Merchant blocked.
// Roles are derived from persona_kind + scope per PRODUCT_VISION §1.1.

import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

const ROLES = [
  { code: "SUPER_ADMIN", scope: "platform-wide", permissions: ["*"], description: "Katana operator — full visibility, approval authority." },
  { code: "PROVIDER_OWNER", scope: "provider", permissions: ["provider.read","provider.kyc.upload","merchant.create","sub_mid.request"], description: "Provider admin — onboards branches, requests Sub-MIDs." },
  { code: "PROVIDER_OPERATOR", scope: "provider", permissions: ["provider.read","merchant.read","sub_mid.read"], description: "Provider day-to-day ops." },
  { code: "PROVIDER_READER", scope: "provider", permissions: ["provider.read","merchant.read"], description: "Provider read-only." },
  { code: "MERCHANT_OWNER", scope: "merchant", permissions: ["merchant.read","api_key.issue","webhook.config"], description: "Branch admin — manages keys + webhooks." },
  { code: "MERCHANT_OPERATOR", scope: "merchant", permissions: ["merchant.read","checkout.create"], description: "Branch operational." },
  { code: "MERCHANT_READER", scope: "merchant", permissions: ["merchant.read"], description: "Branch read-only." },
];

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  return NextResponse.json({ roles: ROLES });
}
