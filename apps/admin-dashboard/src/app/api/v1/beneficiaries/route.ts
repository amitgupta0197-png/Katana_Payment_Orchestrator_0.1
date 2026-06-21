// POST /api/v1/beneficiaries — register a payout beneficiary (BRD §11.B, §9).
//   Created PENDING; a checker must approve before it can be paid (whitelist).
// GET  /api/v1/beneficiaries — list beneficiaries (account number masked, SEC-008).

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse, resolveProviderMerchants } from "@/lib/scope";
import { createBeneficiary, maskAccount } from "@/lib/fifo-payout";

export const dynamic = "force-dynamic";

const schema = z.object({
  merchant_id: z.string().optional(),
  beneficiary_name: z.string().min(1),
  bank_name: z.string().optional(),
  account_number: z.string().optional(),
  ifsc: z.string().optional(),
  upi_id: z.string().optional(),
  wallet_address: z.string().optional(),
  network: z.string().optional(),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["MERCHANT", "SUPER_ADMIN", "ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  const merchantId = s.persona === "MERCHANT" ? s.scope_id! : body.merchant_id;
  if (!merchantId) return NextResponse.json({ error: "merchant_id required" }, { status: 400 });
  try {
    const r = await createBeneficiary({
      merchantId, beneficiaryName: body.beneficiary_name, bankName: body.bank_name,
      accountNumber: body.account_number, ifsc: body.ifsc, upiId: body.upi_id,
      walletAddress: body.wallet_address, network: body.network, createdBy: s.email,
    });
    return NextResponse.json({ id: r.id, status: "PENDING" }, { status: 201 });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

export async function GET(req: Request) {
  const g = await gateOrResponse(["MERCHANT", "PROVIDER", "OPERATOR", "SUPER_ADMIN", "ADMIN", "FINANCE", "COMPLIANCE", "RISK"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  try {
    const params: unknown[] = ["tenant-default"];
    let where = "tenant_id = $1";
    if (s.persona === "MERCHANT") { where += ` AND merchant_id = $${params.length + 1}`; params.push(s.scope_id); }
    else if (s.persona === "PROVIDER") {
      const ids = await resolveProviderMerchants(s);
      if (!ids.length) return NextResponse.json({ beneficiaries: [] });
      where += ` AND merchant_id = ANY($${params.length + 1}::text[])`; params.push(ids);
    }
    if (status) { where += ` AND status = $${params.length + 1}`; params.push(status); }
    const list = await rows<any>("fifo", `
      SELECT id::text, merchant_id, beneficiary_name, bank_name, account_number, ifsc, upi_id,
             wallet_address, network, status, created_by, approved_by, created_at, approved_at
        FROM fifo_beneficiaries WHERE ${where} ORDER BY created_at DESC LIMIT 200
    `, params);
    // Mask account numbers in the response (SEC-008).
    const masked = list.map((b) => ({ ...b, account_number: maskAccount(b.account_number).masked }));
    return NextResponse.json({ beneficiaries: masked });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
