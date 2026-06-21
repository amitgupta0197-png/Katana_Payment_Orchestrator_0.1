// GET /api/v1/reconciliation — recon runs, plus the items of the latest (or ?run_id).
// BRD §21.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "FINANCE", "COMPLIANCE", "RISK"]);
  if ("response" in g) return g.response;
  const runId = new URL(req.url).searchParams.get("run_id");
  try {
    const runs = await rows<any>("fifo", `
      SELECT id::text, source, total_items, matched, mismatched, summary, created_by, created_at
        FROM fifo_recon_runs ORDER BY created_at DESC LIMIT 50
    `);
    const targetRun = runId ?? runs[0]?.id ?? null;
    const items = targetRun ? await rows<any>("fifo", `
      SELECT order_ref, txn_ref, utr, direction, expected_minor::text, reported_minor::text, bucket, detail, resolved
        FROM fifo_recon_items WHERE run_id = $1::uuid ORDER BY (bucket='MATCHED'), bucket, order_ref LIMIT 1000
    `, [targetRun]) : [];
    return NextResponse.json({ runs, run_id: targetRun, items });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
