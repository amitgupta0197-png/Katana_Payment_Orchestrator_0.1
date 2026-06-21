// GET /api/v1/cases/[id] — a case with its notes/evidence timeline (BRD §23).

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "COMPLIANCE", "RISK"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  try {
    const c = (await rows<any>("fifo", `
      SELECT id::text, case_ref, subject, merchant_id, order_ref, severity, status, opened_by, assigned_to, created_at, closed_at
        FROM fifo_cases WHERE id::text=$1 OR case_ref=$1 LIMIT 1
    `, [id]))[0];
    if (!c) return NextResponse.json({ error: "case not found" }, { status: 404 });
    const notes = await rows<any>("fifo", `
      SELECT kind, body, evidence_ref, author, created_at FROM fifo_case_notes WHERE case_id=$1::uuid ORDER BY created_at ASC
    `, [c.id]);
    return NextResponse.json({ case: c, notes });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
