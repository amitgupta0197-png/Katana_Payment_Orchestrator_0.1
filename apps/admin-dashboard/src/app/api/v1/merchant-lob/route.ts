// GET/POST /api/v1/merchant-lob — approved line-of-business / MCC allow-list per
// merchant (BRD §27). Orders whose purpose isn't in the list are flagged at intake.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

const schema = z.object({
  merchant_id: z.string().min(1),
  allowed_purposes: z.array(z.string()).default([]),
  mcc: z.string().optional(),
});

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "COMPLIANCE", "RISK"]);
  if ("response" in g) return g.response;
  try {
    const lobs = await rows<any>("fifo", `SELECT merchant_id, allowed_purposes, mcc, created_at FROM fifo_merchant_lob ORDER BY merchant_id`);
    return NextResponse.json({ lobs });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "COMPLIANCE"]);
  if ("response" in g) return g.response;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  try {
    await rows("fifo", `
      INSERT INTO fifo_merchant_lob (merchant_id, allowed_purposes, mcc) VALUES ($1,$2,$3)
      ON CONFLICT (merchant_id) DO UPDATE SET allowed_purposes=EXCLUDED.allowed_purposes, mcc=EXCLUDED.mcc
    `, [body.merchant_id, body.allowed_purposes, body.mcc ?? null]);
    return NextResponse.json({ ok: true });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
