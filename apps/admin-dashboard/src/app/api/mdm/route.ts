// /api/mdm — MDM home: per master type its record count, template version, field counts and
// last change (lib/mdm-store). Staff only.

import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { MDM_READ, home } from "@/lib/mdm-store";
import { mdmErrorResponse } from "@/lib/mdm-http";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(MDM_READ);
  if ("response" in g) return g.response;
  try { return NextResponse.json({ types: await home() }); } catch (e) { return mdmErrorResponse(e); }
}
