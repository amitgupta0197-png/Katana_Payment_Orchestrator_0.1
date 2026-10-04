// /api/mdm/{type}/{id} — one master record (lib/mdm-store). Staff only.
//   GET    core fields (read-only; sealed ones only say whether they are set), custom values,
//          relationships, change history, the pending approval
//   PATCH  { values: { <custom key>: value | null }, notes? }  custom fields only. Core fields
//          stay edited on their own page (`edit_href`). A field marked requires_approval is
//          raised as a Maker-Checker request (`mdm.extra_update`); the rest apply at once.

import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { MDM_READ, MDM_WRITE, getRecord, setExtra } from "@/lib/mdm-store";
import { mdmErrorResponse, typeOr404 } from "@/lib/mdm-http";
import { jsonBody } from "@/lib/chain-http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ type: string; id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const g = await gateOrResponse(MDM_READ);
  if ("response" in g) return g.response;
  const p = await ctx.params;
  const t = typeOr404(p.type);
  if ("response" in t) return t.response;
  try { return NextResponse.json(await getRecord(t.type, p.id)); } catch (e) { return mdmErrorResponse(e); }
}

export async function PATCH(req: Request, ctx: Ctx) {
  const g = await gateOrResponse(MDM_WRITE);
  if ("response" in g) return g.response;
  const p = await ctx.params;
  const t = typeOr404(p.type);
  if ("response" in t) return t.response;
  const b = await jsonBody(req);
  if (!b || !b.values || typeof b.values !== "object" || Array.isArray(b.values))
    return NextResponse.json({ error: "values (an object of custom field values) is required" }, { status: 400 });
  try {
    const r = await setExtra(t.type, p.id, b.values, { id: g.session.user_id, email: g.session.email },
      typeof b.notes === "string" && b.notes.trim() ? b.notes.trim().slice(0, 500) : undefined);
    return NextResponse.json(r, { status: r.request_id ? 202 : 200 });
  } catch (e) { return mdmErrorResponse(e); }
}
