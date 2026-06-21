// GET/POST /api/v1/merchant-limits — per-merchant transaction limits (BRD FR-003,
// §11.A). NULL on a dimension = no limit there.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { toMinor } from "@/lib/money";

export const dynamic = "force-dynamic";

const schema = z.object({
  merchant_id: z.string().min(1),
  currency: z.string().default("INR"),
  per_txn: z.union([z.number(), z.string()]).optional(),
  daily: z.union([z.number(), z.string()]).optional(),
  monthly: z.union([z.number(), z.string()]).optional(),
});

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "COMPLIANCE", "RISK", "FINANCE"]);
  if ("response" in g) return g.response;
  try {
    const limits = await rows<any>("fifo", `
      SELECT merchant_id, currency, per_txn_minor::text, daily_minor::text, monthly_minor::text, created_at
        FROM fifo_merchant_limits ORDER BY merchant_id
    `);
    return NextResponse.json({ limits });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "COMPLIANCE"]);
  if ("response" in g) return g.response;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  const cur = body.currency.toUpperCase();
  const m = (v: number | string | undefined) => v === undefined || v === "" ? null : toMinor(String(v), cur).toString();
  try {
    await rows("fifo", `
      INSERT INTO fifo_merchant_limits (merchant_id, currency, per_txn_minor, daily_minor, monthly_minor)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (merchant_id) DO UPDATE SET currency=EXCLUDED.currency,
        per_txn_minor=EXCLUDED.per_txn_minor, daily_minor=EXCLUDED.daily_minor, monthly_minor=EXCLUDED.monthly_minor
    `, [body.merchant_id, cur, m(body.per_txn), m(body.daily), m(body.monthly)]);
    return NextResponse.json({ ok: true });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
