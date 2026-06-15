// SUPER_ADMIN R only (writes via env-var rotation through Vault).
// PRODUCT_VISION §3.4 — static catalogue; promote to DB once ops needs runtime edits.

import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { INTEGRATIONS } from "@/lib/integrations-catalog";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  return NextResponse.json({ integrations: INTEGRATIONS });
}
