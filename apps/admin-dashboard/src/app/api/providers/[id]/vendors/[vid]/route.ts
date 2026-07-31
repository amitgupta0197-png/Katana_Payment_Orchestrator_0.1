// PATCH /api/providers/[id]/vendors/[vid] — update a vendor's details or lifecycle
// status (ACTIVE / BLOCKED / UNDER_REVIEW). No DELETE by design: blocking keeps the
// history intact (settlements snapshot the vendor anyway). SUPER_ADMIN + PROVIDER(own).

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  vendor_name: z.string().min(2).max(120).optional(),
  beneficiary_name: z.string().min(2).max(120).optional(),
  account_number: z.string().max(40).nullish(),
  ifsc: z.string().max(20).nullish(),
  bank_name: z.string().max(120).nullish(),
  bank_branch: z.string().max(120).nullish(),
  account_type: z.enum(["SAVINGS", "CURRENT"]).nullish(),
  vpa: z.string().max(120).nullish(),
  mobile_number: z.string().max(20).nullish(),
  pan: z.string().max(15).nullish(),
  gstin: z.string().max(20).nullish(),
  settlement_ref: z.string().max(60).nullish(),
  category: z.string().max(60).nullish(),
  notes: z.string().max(500).nullish(),
  status: z.enum(["ACTIVE", "BLOCKED", "UNDER_REVIEW"]).optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; vid: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id, vid } = await params;
  if (s.persona === "PROVIDER" && s.scope_id !== id)
    return NextResponse.json({ error: "providers can only manage their own vendors" }, { status: 403 });

  let body: z.infer<typeof patchSchema>;
  try { body = patchSchema.parse(await req.json()); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }

  const sets: string[] = ["updated_at = now()"]; const args: unknown[] = [vid, id];
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue;
    args.push(v); sets.push(`${k} = $${args.length}`);
  }
  if (sets.length === 1) return NextResponse.json({ error: "nothing to update" }, { status: 400 });

  try {
    const upd = await rows<{ id: string; status: string }>("provider", `
      UPDATE provider_vendors SET ${sets.join(", ")}
       WHERE id = $1::uuid AND provider_id = $2::uuid
      RETURNING id::text, status
    `, args);
    if (!upd.length) return NextResponse.json({ error: "vendor not found" }, { status: 404 });

    await rows("provider", `
      INSERT INTO provider_audit_logs (provider_id, actor, action, payload)
      VALUES ($1::uuid, $2, 'provider.vendor.updated', $3::jsonb)
    `, [id, s.email, JSON.stringify({ vendor_id: vid, changes: body })]).catch(() => {});

    return NextResponse.json({ vendor: upd[0] });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
