// /api/providers/[id]/beneficiaries/[benId]
//   PATCH  — toggle active / edit fields. SUPER_ADMIN + PROVIDER(own).
//   DELETE — remove a beneficiary. SUPER_ADMIN + PROVIDER(own).

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

function scopeDenied(session: any, id: string): NextResponse | null {
  if (session.persona === "PROVIDER" && session.scope_id !== id)
    return NextResponse.json({ error: "providers can only manage their own beneficiaries" }, { status: 403 });
  return null;
}

const patchSchema = z.object({
  active: z.boolean().optional(),
  label: z.string().max(120).optional(),
  beneficiary_name: z.string().max(200).optional(),
  account_number: z.string().max(40).optional(),
  ifsc: z.string().max(20).optional(),
  bank_name: z.string().max(120).optional(),
  mobile_number: z.string().max(20).optional(),
  vpa: z.string().max(120).optional(),
  transfer_mode: z.enum(["IMPS", "RTGS", "NEFT", "UPI"]).optional(),
}).strict();

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; benId: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const { id, benId } = await params;
  const denied = scopeDenied(g.session, id);
  if (denied) return denied;

  let body;
  try { body = patchSchema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  const fields = Object.entries(body).filter(([, v]) => v !== undefined);
  if (!fields.length) return NextResponse.json({ error: "no fields to update" }, { status: 400 });

  try {
    const sets: string[] = []; const args: unknown[] = [];
    for (const [k, v] of fields) { args.push(v); sets.push(`${k} = $${args.length}`); }
    args.push(benId); args.push(id);
    const upd = await rows<any>("provider", `
      UPDATE provider_beneficiary_accounts SET ${sets.join(", ")}, updated_at = now()
       WHERE id = $${args.length - 1}::uuid AND provider_id = $${args.length}::uuid
      RETURNING id::text, label, beneficiary_name, account_number, ifsc, bank_name, mobile_number, vpa, transfer_mode, active
    `, args);
    if (!upd.length) return NextResponse.json({ error: "beneficiary not found" }, { status: 404 });
    return NextResponse.json({ beneficiary: upd[0] });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; benId: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const { id, benId } = await params;
  const denied = scopeDenied(g.session, id);
  if (denied) return denied;
  try {
    const del = await rows<any>("provider", `
      DELETE FROM provider_beneficiary_accounts WHERE id = $1::uuid AND provider_id = $2::uuid RETURNING id::text
    `, [benId, id]);
    if (!del.length) return NextResponse.json({ error: "beneficiary not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
