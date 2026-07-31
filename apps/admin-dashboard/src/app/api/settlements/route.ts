// /api/settlements — provider ↔ branch settlements.
//   GET  — scoped list (SUPER_ADMIN: all; PROVIDER: own; MERCHANT/branch: addressed
//          to it). Optional ?provider= &branch= &status= filters for admin/provider.
//   POST — a provider RAISES a settlement to a branch. SUPER_ADMIN + PROVIDER.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { branchKeysForMerchant } from "@/lib/provider-integration";
import { purposeForAmount } from "@/lib/branch-settlement";

export const dynamic = "force-dynamic";

// Enrich rows with provider code/name (provider DB) + branch name (merchant DB).
async function enrich(list: any[]): Promise<any[]> {
  if (!list.length) return list;
  const provIds = [...new Set(list.map((r) => r.provider_id))];
  const codes = [...new Set(list.map((r) => r.merchant_key))];
  const [provs, merchants] = await Promise.all([
    rows<any>("provider", `SELECT id::text, code, legal_name FROM providers WHERE id::text = ANY($1::text[])`, [provIds]).catch(() => []),
    rows<any>("merchant", `SELECT merchant_code, legal_name, COALESCE(brand_name,'') AS brand_name FROM merchants WHERE merchant_code = ANY($1::text[])`, [codes]).catch(() => []),
  ]);
  const pByx = new Map(provs.map((p: any) => [p.id, p]));
  const mByc = new Map(merchants.map((m: any) => [m.merchant_code, m]));
  return list.map((r) => ({
    ...r,
    provider_code: pByx.get(r.provider_id)?.code ?? null,
    provider_name: pByx.get(r.provider_id)?.legal_name ?? null,
    branch_name: mByc.get(r.merchant_key) ? (mByc.get(r.merchant_key).brand_name || mByc.get(r.merchant_key).legal_name) : null,
  }));
}

const SELECT = `
  SELECT id::text, provider_id::text, merchant_key, beneficiary_id::text, beneficiary_snapshot,
         amount::float AS amount, currency, purpose, status, utr, transfer_mode, note,
         requested_by, requested_at, utr_submitted_by, utr_submitted_at,
         verified_by, verified_at, review_by, review_at, review_note, updated_at, created_at
    FROM provider_branch_settlements`;

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const url = new URL(req.url);
  const fProvider = url.searchParams.get("provider");
  const fBranch = url.searchParams.get("branch");
  const fStatus = url.searchParams.get("status");

  const where: string[] = []; const args: unknown[] = [];
  try {
    if (s.persona === "PROVIDER") { args.push(s.scope_id); where.push(`provider_id = $${args.length}::uuid`); }
    else if (s.persona === "MERCHANT") {
      const keys = await branchKeysForMerchant(s.scope_id!);
      args.push(keys); where.push(`merchant_key = ANY($${args.length}::text[])`);
    } else {
      if (fProvider) { args.push(fProvider); where.push(`provider_id = $${args.length}::uuid`); }
    }
    if (fBranch && s.persona !== "MERCHANT") { args.push(fBranch); where.push(`merchant_key = $${args.length}`); }
    if (fStatus) { args.push(fStatus); where.push(`status = $${args.length}`); }

    const list = await rows<any>("provider",
      `${SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT 300`, args);
    return NextResponse.json({ settlements: await enrich(list) });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const createSchema = z.object({
  provider_id: z.string().uuid().optional(), // required for SUPER_ADMIN; ignored for PROVIDER
  merchant_key: z.string().min(1).max(120),
  amount: z.coerce.number().positive().max(1_000_000_000),
  beneficiary_id: z.string().uuid(),
  purpose: z.string().max(60).optional(),
  note: z.string().max(500).optional(),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const s = g.session;

  let body;
  try { body = createSchema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  const providerId = s.persona === "PROVIDER" ? s.scope_id! : body.provider_id;
  if (!providerId) return NextResponse.json({ error: "provider_id required" }, { status: 400 });

  try {
    // Beneficiary must belong to this provider — snapshot it so the branch always
    // sees the exact account it was told to pay, even if the benef is later edited.
    const ben = (await rows<any>("provider", `
      SELECT id::text, label, beneficiary_name, account_number, ifsc, bank_name, mobile_number, vpa, transfer_mode
        FROM provider_beneficiary_accounts WHERE id = $1::uuid AND provider_id = $2::uuid AND active = true
    `, [body.beneficiary_id, providerId]))[0];
    if (!ben) return NextResponse.json({ error: "beneficiary not found / not active for this provider" }, { status: 404 });

    const purpose = body.purpose || purposeForAmount(body.amount);
    const ins = await rows<any>("provider", `
      INSERT INTO provider_branch_settlements
        (provider_id, merchant_key, beneficiary_id, beneficiary_snapshot, amount, purpose, transfer_mode, note, status, requested_by)
      VALUES ($1::uuid,$2,$3::uuid,$4::jsonb,$5,$6,$7,$8,'REQUESTED',$9)
      RETURNING id::text, provider_id::text, merchant_key, amount::float AS amount, currency, status, purpose, created_at
    `, [providerId, body.merchant_key, ben.id, JSON.stringify(ben), body.amount, purpose, ben.transfer_mode, body.note ?? null, s.email]);

    await rows("provider", `
      INSERT INTO provider_audit_logs (provider_id, actor, action, payload)
      VALUES ($1::uuid, $2, 'provider.settlement.raised', $3::jsonb)
    `, [providerId, s.email, JSON.stringify({ branch: body.merchant_key, amount: body.amount, purpose })]).catch(() => {});

    return NextResponse.json({ settlement: ins[0] });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
