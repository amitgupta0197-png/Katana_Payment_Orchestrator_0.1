// GET full UAM matrix; PATCH single cell. SUPER_ADMIN only edits — others
// see their own persona row (defense-in-depth; UI hides edit controls).
import { NextResponse } from "next/server";
import { z } from "zod";
import { gateOrResponse } from "@/lib/scope";
import { getMatrix, listModules, setCell } from "@/lib/access";
import { pgError } from "@/lib/pg";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  try {
    const [modules, matrix] = await Promise.all([listModules(), getMatrix(g.session.persona)]);
    return NextResponse.json({ modules, matrix });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const patchSchema = z.object({
  module_code: z.string().min(1),
  persona: z.enum(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]),
  can_create: z.boolean().optional(),
  can_read: z.boolean().optional(),
  can_update: z.boolean().optional(),
  can_delete: z.boolean().optional(),
  can_admin: z.boolean().optional(),
});

export async function PATCH(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  let body;
  try { body = patchSchema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  const { module_code, persona, ...rights } = body;
  if (!Object.keys(rights).length)
    return NextResponse.json({ error: "no rights to update" }, { status: 400 });
  try {
    const cell = await setCell(module_code, persona, rights, g.session.email);
    return NextResponse.json(cell);
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
