// POST /api/routing/simulate — dry-run pickRoute without charging or
// persisting anything. Same logic as POST /api/checkout but stops after the
// candidate list is built, so operators can preview a hypothetical txn.
//
// BRD §6 P2 acceptance: "route can be replayed for audit" — same code path.

import { NextResponse } from "next/server";
import { z } from "zod";
import { gateOrResponse } from "@/lib/scope";
import { toMinor } from "@/lib/money";
import { pickRoute } from "@/lib/routing";

export const dynamic = "force-dynamic";

const schema = z.object({
  method: z.string().min(1),
  amount: z.union([z.number().positive(), z.string()]),
  currency: z.string().default("INR"),
  merchant_id: z.string().default("tenant-default"),
  risk_score: z.number().min(0).max(1).optional(),
  txn_id: z.string().optional(),
});

const RAIL_METHOD: Record<string, string> = {
  UPI_INTENT: "UPI_INTENT", UPI_COLLECT: "UPI_COLLECT", CARD: "CARD",
  NETBANKING: "NETBANKING", NET_BANKING: "NETBANKING",
  WALLET: "WALLET", QR: "QR", CRYPTO: "CRYPTO",
};

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  const amountMinor = toMinor(typeof body.amount === "number" ? body.amount.toString() : body.amount, body.currency);
  const railMethod = RAIL_METHOD[body.method.toUpperCase()] ?? body.method.toUpperCase();
  const result = await pickRoute({
    method: railMethod, amountMinor, currency: body.currency,
    merchantId: body.merchant_id, riskScore: body.risk_score,
    txnId: body.txn_id,
  });
  return NextResponse.json({
    simulated: true,
    method: railMethod,
    amount_minor: String(amountMinor),
    currency: body.currency,
    candidates: result.candidates.map(c => ({
      rank: c.rank, provider: c.provider, score: Number(c.score.toFixed(4)),
      reasoning: c.reasoning, factors: c.factors,
    })),
    excluded: result.excluded,
    experiment: result.experiment,
    weights_applied: result.weights_applied,
  });
}
