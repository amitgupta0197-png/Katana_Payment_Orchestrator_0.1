// /api/mdm/templates — every master type's current template (lib/mdm-store). Staff only.

import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { MDM_READ, getTemplate } from "@/lib/mdm-store";
import { MASTER_TYPES } from "@/lib/mdm";
import { mdmErrorResponse } from "@/lib/mdm-http";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(MDM_READ);
  if ("response" in g) return g.response;
  try { return NextResponse.json({ templates: await Promise.all(MASTER_TYPES.map((t) => getTemplate(t))) }); }
  catch (e) { return mdmErrorResponse(e); }
}
