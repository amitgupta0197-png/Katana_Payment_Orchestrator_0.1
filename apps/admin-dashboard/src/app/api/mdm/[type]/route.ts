// /api/mdm/{type}?page=&q= — a master type's records, 25 a page: core summary columns, custom
// values and relationship counts (lib/mdm-store). Staff only.

import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { MDM_READ, listRecords } from "@/lib/mdm-store";
import { mdmErrorResponse, typeOr404 } from "@/lib/mdm-http";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ type: string }> }) {
  const g = await gateOrResponse(MDM_READ);
  if ("response" in g) return g.response;
  const t = typeOr404((await ctx.params).type);
  if ("response" in t) return t.response;
  const u = new URL(req.url);
  try {
    return NextResponse.json(await listRecords(t.type, { page: Number(u.searchParams.get("page") ?? 1), q: u.searchParams.get("q") ?? "" }));
  } catch (e) { return mdmErrorResponse(e); }
}
