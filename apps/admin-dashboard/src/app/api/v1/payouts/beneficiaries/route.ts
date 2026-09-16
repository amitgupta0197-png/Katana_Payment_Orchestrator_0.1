// POST /api/v1/payouts/beneficiaries — merchant server registers a payout beneficiary,
// authenticated by the merchant's Key + Salt (allow-listed in middleware).
//
//   hash over: beneficiary_ref|name|account_number|ifsc|upi_id
//
// A beneficiary is created PENDING and can't be paid until someone at Katana other than the
// registering key approves it. Re-sending the same beneficiary_ref with the same details
// returns the existing one with its current status, so this doubles as a status check.
import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { createBeneficiary } from "@/lib/fifo-payout";
import { authPayoutRequest, parseMerchantBody } from "@/lib/payout-api";

export const dynamic = "force-dynamic";

const schema = z.object({
  key: z.string().min(1),
  hash: z.string().min(1),
  beneficiary_ref: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, "beneficiary_ref: 1-40 letters, digits, _ or -"),
  name: z.string().trim().min(1).max(100),
  account_number: z.string().regex(/^[A-Za-z0-9]{6,20}$/, "account_number: 6-20 letters or digits").optional(),
  ifsc: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, "ifsc: 11 characters, e.g. HDFC0001234").optional(),
  upi_id: z.string().regex(/^[A-Za-z0-9._-]{2,256}@[A-Za-z]{2,64}$/, "upi_id: e.g. name@okhdfc").optional(),
  bank_name: z.string().max(100).optional(),
}).refine((b) => !!b.account_number === !!b.ifsc, "account_number and ifsc go together")
  .refine((b) => !!(b.account_number || b.upi_id), "send account_number + ifsc, or upi_id");

type Bene = { id: string; merchant_ref: string; status: string; beneficiary_name: string;
  account_number: string | null; account_last4: string | null; ifsc: string | null; upi_id: string | null };

const view = (b: Bene) => ({
  beneficiary_id: b.id, beneficiary_ref: b.merchant_ref, status: b.status, name: b.beneficiary_name,
  account_last4: b.account_last4, ifsc: b.ifsc, upi_id: b.upi_id,
});

async function findByRef(merchantCode: string, ref: string): Promise<Bene | null> {
  return (await rows<Bene>("fifo", `
    SELECT id::text, merchant_ref, status, beneficiary_name, account_number, account_last4, ifsc, upi_id
      FROM fifo_beneficiaries WHERE merchant_id=$1 AND merchant_ref=$2
  `, [merchantCode, ref]))[0] ?? null;
}

// Same ref, different details: refuse rather than silently keep the old account.
function sameDetails(b: Bene, body: z.infer<typeof schema>): boolean {
  return b.beneficiary_name === body.name && (b.account_number ?? null) === (body.account_number ?? null)
    && (b.ifsc ?? null) === (body.ifsc ?? null) && (b.upi_id ?? null) === (body.upi_id ?? null);
}

export async function POST(req: Request) {
  let body;
  try {
    const raw = await parseMerchantBody(req);
    if (typeof raw.ifsc === "string") raw.ifsc = raw.ifsc.toUpperCase();
    body = schema.parse(raw);
  } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }

  try {
    const auth = await authPayoutRequest(body.key, body.hash,
      [body.beneficiary_ref, body.name, body.account_number, body.ifsc, body.upi_id]);
    if (!auth.ok) return NextResponse.json({ error: auth.error, code: auth.code }, { status: auth.status });

    const existing = await findByRef(auth.merchantCode, body.beneficiary_ref);
    if (existing) {
      if (!sameDetails(existing, body))
        return NextResponse.json({ error: `beneficiary_ref ${body.beneficiary_ref} is already registered with different details` }, { status: 409 });
      return NextResponse.json({ beneficiary: view(existing), reused: true });
    }

    try {
      await createBeneficiary({
        merchantId: auth.merchantCode, merchantRef: body.beneficiary_ref, beneficiaryName: body.name,
        bankName: body.bank_name, accountNumber: body.account_number, ifsc: body.ifsc, upiId: body.upi_id,
        createdBy: `api:${body.key}`,
      });
    } catch (err) {
      // A parallel request with the same ref won; fall through and return its row.
      if ((err as { code?: string }).code !== "23505") throw err;
    }
    const created = await findByRef(auth.merchantCode, body.beneficiary_ref);
    if (!created) return NextResponse.json({ error: "beneficiary not saved" }, { status: 500 });
    if (!sameDetails(created, body))
      return NextResponse.json({ error: `beneficiary_ref ${body.beneficiary_ref} is already registered with different details` }, { status: 409 });
    return NextResponse.json({ beneficiary: view(created), reused: false }, { status: 201 });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
