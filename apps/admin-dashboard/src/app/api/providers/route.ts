// Persona policy (PRODUCT_VISION §3.1):
//   SUPER_ADMIN — list all; create.
//   PROVIDER    — read own row only.
//   MERCHANT    — forbidden (middleware also blocks, but defense-in-depth).

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const s = g.session;

  const tenant = "tenant-default";
  try {
    const params: unknown[] = [tenant];
    let where = "p.tenant_id = $1";
    if (s.persona === "PROVIDER") {
      where += " AND p.id = $2::uuid";
      params.push(s.scope_id);
    }
    const providers = await rows<any>("provider", `
      SELECT p.id, p.tenant_id, p.code, p.legal_name, p.contact_email::text AS contact_email,
             COALESCE(p.contact_phone,'') AS contact_phone, p.kind,
             p.kyc_status, p.status, p.settlement_currency,
             COALESCE(p.bank_account_no,'') AS bank_account_no,
             COALESCE(p.bank_ifsc,'') AS bank_ifsc,
             p.created_at,
             (SELECT COUNT(*)::int FROM provider_users u WHERE u.provider_id = p.id) AS user_count,
             (SELECT COUNT(*)::int FROM provider_kyc_documents d WHERE d.provider_id = p.id) AS doc_count,
             (SELECT COUNT(*)::int FROM provider_merchant_mappings m WHERE m.provider_id = p.id) AS merchant_count
        FROM providers p
       WHERE ${where}
       ORDER BY p.created_at DESC LIMIT 200
    `, params);
    return NextResponse.json({ providers });
  } catch (err) {
    const e = pgError(err);
    return NextResponse.json(e.body, { status: e.status });
  }
}

const createSchema = z.object({
  code: z.string().min(2).max(60),
  legal_name: z.string().min(2).max(255),
  contact_email: z.string().email(),
  contact_phone: z.string().optional(),
  kind: z.enum(["PROVIDER","AGENT","PARTNER","FRANCHISE"]).default("PROVIDER"),
  bank_account_no: z.string().optional(),
  bank_ifsc: z.string().optional(),
  settlement_currency: z.string().default("INR"),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;

  const tenant = req.headers.get("x-tenant-id") ?? "tenant-default";
  let body;
  try { body = createSchema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const res = await rows<any>("provider", `
      INSERT INTO providers (tenant_id, code, legal_name, contact_email, contact_phone, kind,
                             bank_account_no, bank_ifsc, settlement_currency, kyc_status, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PENDING', 'ACTIVE')
      ON CONFLICT (tenant_id, code) DO UPDATE SET
        legal_name = EXCLUDED.legal_name, contact_email = EXCLUDED.contact_email,
        contact_phone = EXCLUDED.contact_phone, updated_at = now()
      RETURNING id, code, legal_name, kyc_status, status, created_at
    `, [tenant, body.code, body.legal_name, body.contact_email, body.contact_phone ?? null, body.kind,
        body.bank_account_no ?? null, body.bank_ifsc ?? null, body.settlement_currency]);
    return NextResponse.json(res[0]);
  } catch (err) {
    const e = pgError(err);
    return NextResponse.json(e.body, { status: e.status });
  }
}
