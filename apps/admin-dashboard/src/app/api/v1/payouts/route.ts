// POST /api/v1/payouts — create a payout order (BRD §18, FR-007). Validates an
// APPROVED beneficiary + merchant payable balance; high-value routes to maker-checker.

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { toMinor } from "@/lib/money";
import { createPayout } from "@/lib/fifo-payout";

export const dynamic = "force-dynamic";

const schema = z.object({
  merchant_id: z.string().optional(),
  beneficiary_id: z.string().uuid(),
  amount: z.union([z.number().positive(), z.string().min(1)]),
  currency: z.string().default("INR"),
  settlement_mode: z.enum(["BANK", "USDT", "WALLET", "UPI"]).optional(),
  purpose: z.string().optional(),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["MERCHANT", "SUPER_ADMIN", "ADMIN", "FINANCE", "OPERATOR"]);
  if ("response" in g) return g.response;
  const s = g.session;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  const merchantId = s.persona === "MERCHANT" ? s.scope_id! : body.merchant_id;
  if (!merchantId) return NextResponse.json({ error: "merchant_id required" }, { status: 400 });
  const currency = body.currency.toUpperCase();
  const amountStr = typeof body.amount === "number" ? body.amount.toString() : body.amount;
  try {
    const r = await createPayout({
      merchantId, beneficiaryId: body.beneficiary_id, amountMinor: toMinor(amountStr, currency), currency,
      settlementMode: body.settlement_mode, purpose: body.purpose, actor: s.email,
    });
    if (r.error) return NextResponse.json({ error: r.error }, { status: r.status ?? 400 });
    return NextResponse.json({ order: r.order }, { status: 201 });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
