// /api/providers/[id]/vendors — the upline's vendor registry (BRD §3).
//   GET  — list vendors (with doc counts). SUPER_ADMIN + PROVIDER(own).
//   POST — add a vendor. SUPER_ADMIN + PROVIDER(own).
// Branches (downline) have NO access here — they only ever see the vendor snapshot on a
// settlement addressed to them (the BRD visibility rule).

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

function scopeDenied(session: { persona: string; scope_id: string | null }, id: string): NextResponse | null {
  if (session.persona === "PROVIDER" && session.scope_id !== id)
    return NextResponse.json({ error: "providers can only manage their own vendors" }, { status: 403 });
  return null;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  const denied = scopeDenied(g.session, id);
  if (denied) return denied;
  try {
    const vendors = await rows("provider", `
      SELECT v.id::text, v.vendor_name, v.beneficiary_name, v.account_number, v.ifsc, v.bank_name,
             v.bank_branch, v.account_type, v.vpa, v.mobile_number, v.pan, v.gstin, v.settlement_ref,
             v.category, v.status, v.notes, v.created_by, v.created_at, v.updated_at,
             COUNT(d.id)::int AS doc_count
        FROM provider_vendors v
        LEFT JOIN provider_vendor_documents d ON d.vendor_id = v.id
       WHERE v.provider_id = $1::uuid
       GROUP BY v.id
       ORDER BY v.created_at DESC
    `, [id]);
    return NextResponse.json({ vendors });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const createSchema = z.object({
  vendor_name: z.string().min(2).max(120),
  beneficiary_name: z.string().min(2).max(120),
  account_number: z.string().max(40).optional(),
  ifsc: z.string().max(20).optional(),
  bank_name: z.string().max(120).optional(),
  bank_branch: z.string().max(120).optional(),
  account_type: z.enum(["SAVINGS", "CURRENT"]).optional(),
  vpa: z.string().max(120).optional(),
  mobile_number: z.string().max(20).optional(),
  pan: z.string().max(15).optional(),
  gstin: z.string().max(20).optional(),
  settlement_ref: z.string().max(60).optional(),
  category: z.string().max(60).optional(),
  notes: z.string().max(500).optional(),
}).refine((b) => b.vpa || (b.account_number && b.ifsc), { message: "either a VPA or account_number + IFSC is required" });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;
  const denied = scopeDenied(s, id);
  if (denied) return denied;

  let body: z.infer<typeof createSchema>;
  try { body = createSchema.parse(await req.json()); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }

  try {
    const ins = await rows<{ id: string }>("provider", `
      INSERT INTO provider_vendors
        (provider_id, vendor_name, beneficiary_name, account_number, ifsc, bank_name, bank_branch,
         account_type, vpa, mobile_number, pan, gstin, settlement_ref, category, notes, created_by)
      VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      RETURNING id::text
    `, [id, body.vendor_name, body.beneficiary_name, body.account_number ?? null, body.ifsc ?? null,
        body.bank_name ?? null, body.bank_branch ?? null, body.account_type ?? null, body.vpa ?? null,
        body.mobile_number ?? null, body.pan ?? null, body.gstin ?? null, body.settlement_ref ?? null,
        body.category ?? null, body.notes ?? null, s.email]);

    await rows("provider", `
      INSERT INTO provider_audit_logs (provider_id, actor, action, payload)
      VALUES ($1::uuid, $2, 'provider.vendor.added', $3::jsonb)
    `, [id, s.email, JSON.stringify({ vendor_id: ins[0].id, vendor_name: body.vendor_name })]).catch(() => {});

    return NextResponse.json({ vendor_id: ins[0].id });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
