// GET / PATCH a single provider.
// SUPER_ADMIN: full read + update kyc_status / status / bank.
// PROVIDER: read own only; update bank fields only.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;

  if (s.persona === "PROVIDER" && s.scope_id !== id)
    return NextResponse.json({ error: "providers can only read own row" }, { status: 403 });

  try {
    const provider = await rows<any>("provider", `
      SELECT p.id::text, p.tenant_id, p.code, p.legal_name,
             p.contact_email::text AS contact_email, COALESCE(p.contact_phone,'') AS contact_phone,
             p.kind, p.kyc_status, p.status, p.settlement_currency,
             COALESCE(p.bank_account_no,'') AS bank_account_no,
             COALESCE(p.bank_ifsc,'') AS bank_ifsc,
             p.created_at, p.updated_at
        FROM providers p WHERE p.id = $1::uuid
    `, [id]);
    if (!provider.length) return NextResponse.json({ error: "not found" }, { status: 404 });

    const users = await rows<any>("provider", `
      SELECT id::text, email, COALESCE(name,'') AS name, role, created_at
        FROM provider_users WHERE provider_id = $1::uuid ORDER BY created_at DESC
    `, [id]).catch(() => []);
    const docs = await rows<any>("provider", `
      SELECT id::text, doc_type, uri, sha256,
             COALESCE(verified_at::text,'') AS verified_at,
             COALESCE(verified_by,'') AS verified_by, created_at
        FROM provider_kyc_documents WHERE provider_id = $1::uuid ORDER BY created_at DESC
    `, [id]).catch(() => []);
    const commission = await rows<any>("provider", `
      SELECT id::text, rule_kind, rate_bps, fixed_fee, currency, valid_from, valid_to
        FROM provider_commission_rules WHERE provider_id = $1::uuid ORDER BY valid_from DESC
    `, [id]).catch(() => []);
    const mappings = await rows<any>("provider", `
      SELECT id::text, merchant_id, relation, created_at
        FROM provider_merchant_mappings WHERE provider_id = $1::uuid ORDER BY created_at DESC
    `, [id]).catch(() => []);

    return NextResponse.json({ provider: provider[0], users, docs, commission, mappings });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const patchSchema = z.object({
  kyc_status: z.enum(["PENDING","IN_REVIEW","APPROVED","REJECTED","EXPIRED"]).optional(),
  status: z.enum(["ACTIVE","SUSPENDED","TERMINATED"]).optional(),
  bank_account_no: z.string().optional(),
  bank_ifsc: z.string().optional(),
  contact_phone: z.string().optional(),
  notes: z.string().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;

  let body;
  try { body = patchSchema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  // Persona-restricted field allowlists.
  const allowed = s.persona === "SUPER_ADMIN"
    ? new Set(Object.keys(patchSchema.shape))
    : new Set(["bank_account_no", "bank_ifsc", "contact_phone"]);

  if (s.persona === "PROVIDER" && s.scope_id !== id)
    return NextResponse.json({ error: "providers can only update own row" }, { status: 403 });

  const fields = Object.fromEntries(
    Object.entries(body).filter(([k, v]) => allowed.has(k) && v !== undefined && k !== "notes"),
  );
  if (Object.keys(fields).length === 0)
    return NextResponse.json({ error: "no fields you may edit were supplied" }, { status: 400 });

  try {
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      args.push(v);
      sets.push(`${k} = $${args.length}`);
    }
    args.push(id);
    const res = await rows<any>("provider", `
      UPDATE providers SET ${sets.join(", ")}, updated_at = now()
       WHERE id = $${args.length}::uuid
       RETURNING id::text, code, kyc_status, status, updated_at
    `, args);
    if (!res.length) return NextResponse.json({ error: "not found" }, { status: 404 });
    await rows("provider", `
      INSERT INTO provider_audit_logs (provider_id, action, actor, payload)
      VALUES ($1::uuid, $2, $3, $4::jsonb)
    `, [id, "PROVIDER_UPDATED", s.email, JSON.stringify({ fields, notes: body.notes })]).catch(() => {});
    return NextResponse.json(res[0]);
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
