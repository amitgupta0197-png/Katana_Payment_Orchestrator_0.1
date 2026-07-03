// /api/providers/[id]/beneficiaries — the provider's "dedicated accounts" a branch
// settles into.
//   GET  — list. SUPER_ADMIN + PROVIDER(own).
//   POST — add a beneficiary bank account. SUPER_ADMIN + PROVIDER(own).

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

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  const denied = scopeDenied(g.session, id);
  if (denied) return denied;
  try {
    const list = await rows<any>("provider", `
      SELECT id::text, label, beneficiary_name, account_number, ifsc, bank_name,
             mobile_number, vpa, transfer_mode, active, created_at
        FROM provider_beneficiary_accounts
       WHERE provider_id = $1::uuid
       ORDER BY active DESC, created_at DESC
    `, [id]);
    return NextResponse.json({ beneficiaries: list });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const createSchema = z.object({
  label: z.string().max(120).optional(),
  beneficiary_name: z.string().min(1).max(200),
  account_number: z.string().max(40).optional(),
  ifsc: z.string().max(20).optional(),
  bank_name: z.string().max(120).optional(),
  mobile_number: z.string().max(20).optional(),
  vpa: z.string().max(120).optional(),
  transfer_mode: z.enum(["IMPS", "RTGS", "NEFT", "UPI"]).default("IMPS"),
}).refine((b) => (b.transfer_mode === "UPI" ? !!b.vpa : !!(b.account_number && b.ifsc)), {
  message: "UPI needs a VPA; bank modes need account_number + ifsc",
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;
  const denied = scopeDenied(s, id);
  if (denied) return denied;

  let body;
  try { body = createSchema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const exists = await rows<{ id: string }>("provider", `SELECT id::text FROM providers WHERE id = $1::uuid`, [id]).catch(() => []);
    if (!exists.length) return NextResponse.json({ error: "provider not found" }, { status: 404 });

    const ins = await rows<any>("provider", `
      INSERT INTO provider_beneficiary_accounts
        (provider_id, label, beneficiary_name, account_number, ifsc, bank_name, mobile_number, vpa, transfer_mode, created_by)
      VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING id::text, label, beneficiary_name, account_number, ifsc, bank_name, mobile_number, vpa, transfer_mode, active, created_at
    `, [id, body.label ?? null, body.beneficiary_name, body.account_number ?? null, body.ifsc ?? null,
        body.bank_name ?? null, body.mobile_number ?? null, body.vpa ?? null, body.transfer_mode, s.email]);
    await rows("provider", `
      INSERT INTO provider_audit_logs (provider_id, actor, action, payload)
      VALUES ($1::uuid, $2, 'provider.beneficiary.added', $3::jsonb)
    `, [id, s.email, JSON.stringify({ beneficiary_name: body.beneficiary_name, transfer_mode: body.transfer_mode })]).catch(() => {});
    return NextResponse.json({ beneficiary: ins[0] });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
