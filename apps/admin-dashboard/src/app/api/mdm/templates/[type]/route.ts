// /api/mdm/templates/{type} — one master type's template (lib/mdm-store). Staff only.
//   GET   current version (core fields locked, then custom), the pending proposal, version history
//   POST  { custom_fields: MdmField[], notes? }  propose a new version: a Maker-Checker request
//         (`mdm.template_update`) decided on /admin/maker-checker by a second person.

import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { MDM_READ, MDM_WRITE, getTemplate, listVersions, proposeVersion } from "@/lib/mdm-store";
import { mdmErrorResponse, typeOr404 } from "@/lib/mdm-http";
import { jsonBody } from "@/lib/chain-http";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ type: string }> }) {
  const g = await gateOrResponse(MDM_READ);
  if ("response" in g) return g.response;
  const t = typeOr404((await ctx.params).type);
  if ("response" in t) return t.response;
  try {
    const [template, versions] = await Promise.all([getTemplate(t.type), listVersions(t.type)]);
    return NextResponse.json({ template, versions });
  } catch (e) { return mdmErrorResponse(e); }
}

export async function POST(req: Request, ctx: { params: Promise<{ type: string }> }) {
  const g = await gateOrResponse(MDM_WRITE);
  if ("response" in g) return g.response;
  const t = typeOr404((await ctx.params).type);
  if ("response" in t) return t.response;
  const b = await jsonBody(req);
  if (!b || !Array.isArray(b.custom_fields)) return NextResponse.json({ error: "custom_fields (a list) is required" }, { status: 400 });
  try {
    const r = await proposeVersion(t.type, b.custom_fields, { id: g.session.user_id, email: g.session.email },
      typeof b.notes === "string" && b.notes.trim() ? b.notes.trim().slice(0, 500) : undefined);
    return NextResponse.json(r, { status: 202 });
  } catch (e) { return mdmErrorResponse(e); }
}
