// POST /api/v1/reconciliation/run — run a reconciliation pass (BRD §21, AC-007).
// Body (optional): { source, report: [{reference, amount_minor, utr}] }.

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { runReconciliation, type ReconSource } from "@/lib/fifo-recon";

export const dynamic = "force-dynamic";

const schema = z.object({
  source: z.enum(["LEDGER", "GATEWAY", "BANK", "USDT"]).optional(),
  report: z.array(z.object({ reference: z.string(), amount_minor: z.union([z.number(), z.string()]), utr: z.string().optional() })).optional(),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "FINANCE"]);
  if ("response" in g) return g.response;
  let body: z.infer<typeof schema> = {};
  try { body = schema.parse(await req.json().catch(() => ({}))); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  try {
    const r = await runReconciliation({ source: body.source as ReconSource | undefined, report: body.report, createdBy: g.session.email });
    return NextResponse.json({ ok: true, ...r });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
