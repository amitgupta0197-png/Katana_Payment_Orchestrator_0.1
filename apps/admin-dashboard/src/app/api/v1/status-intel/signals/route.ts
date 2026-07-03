// /api/v1/status-intel/signals
//   POST — ingest a status signal from any source (Layer 2 intake + Layer 3 match).
//   GET  — list recent signals (optionally ?order_ref=).
// This is the universal ingestion endpoint every channel (gateway webhook, bank API,
// SMS/email parser, NPCI/settlement report, pool monitor, trader upload) feeds into.

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { rows } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { ingestSignal } from "@/lib/status-intelligence";

export const dynamic = "force-dynamic";

const schema = z.object({
  source: z.enum([
    "GATEWAY_API", "GATEWAY_WEBHOOK", "BANK_API", "BANK_STATEMENT", "EMAIL_PARSER",
    "SMS_PARSER", "TRADER_UPLOAD", "UTR_VERIFICATION", "NPCI_REPORT", "SETTLEMENT_REPORT", "POOL_MONITOR",
  ]),
  reported_status: z.enum(["INITIATED", "PROCESSING", "PENDING", "SUCCESS", "FAILED", "REVERSED", "CHARGEBACK", "SETTLED", "DUPLICATE"]),
  order_ref: z.string().optional(),
  utr: z.string().optional(),
  rrn: z.string().optional(),
  amount_minor: z.union([z.number(), z.string()]).optional(),
  customer_vpa: z.string().optional(),
  customer_name: z.string().optional(),
  narration: z.string().optional(),
  pool_account: z.string().optional(),
  signal_time: z.string().optional(),
  payload: z.record(z.unknown()).optional(),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "OPERATOR", "FINANCE", "RISK"]);
  if ("response" in g) return g.response;
  let body: z.infer<typeof schema>;
  try { body = schema.parse(await req.json()); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  try {
    const r = await ingestSignal({ ...body, created_by: g.session.email });
    return NextResponse.json({ ok: true, ...r });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "OPERATOR", "FINANCE", "RISK", "COMPLIANCE"]);
  if ("response" in g) return g.response;
  const ref = new URL(req.url).searchParams.get("order_ref");
  try {
    const list = await rows<any>("fifo", `
      SELECT id::text, order_id::text, order_ref, source, reported_status, utr, rrn,
             amount_minor::text, confidence::text, match_method, review_status, signal_time, created_at
        FROM fifo_status_signals
       ${ref ? "WHERE order_ref = $1" : ""}
       ORDER BY created_at DESC LIMIT 200
    `, ref ? [ref] : []);
    return NextResponse.json({ signals: list });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
