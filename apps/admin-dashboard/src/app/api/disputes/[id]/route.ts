// GET   /api/disputes/[id] — single dispute + evidence (scoped by persona).
// PATCH /api/disputes/[id] — transition state, post resolution journal.
// POST  /api/disputes/[id] — attach evidence row.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse, resolveProviderMerchants } from "@/lib/scope";
import { transitionDispute, type DisputeState } from "@/lib/disputes";
import { wormAppend } from "@/lib/worm";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;

  try {
    const r = await rows<any>("riskVelocity", `
      SELECT dispute_id::text, txn_id, COALESCE(order_id::text,'') AS order_id,
             merchant_id, reason_code, amount_minor::text, currency, status,
             deadline_at, opened_at, COALESCE(opened_by,'') AS opened_by,
             resolved_at, COALESCE(resolved_by,'') AS resolved_by,
             COALESCE(resolution_notes,'') AS resolution_notes,
             hold_journal_id::text, COALESCE(resolution_journal_id::text,'') AS resolution_journal_id
        FROM disputes WHERE dispute_id = $1::uuid LIMIT 1
    `, [id]).catch(() => []);
    if (!r.length) return NextResponse.json({ error: "not found" }, { status: 404 });
    const dispute = r[0];

    // Scope re-check after load — never trust the id alone.
    if (s.persona === "MERCHANT" && dispute.merchant_id !== s.scope_id)
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    if (s.persona === "PROVIDER") {
      const ids = await resolveProviderMerchants(s);
      if (!ids.includes(dispute.merchant_id))
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const evidence = await rows<any>("riskVelocity", `
      SELECT evidence_id::text, evidence_type, COALESCE(file_url,'') AS file_url,
             COALESCE(notes,'') AS notes, COALESCE(submitted_by,'') AS submitted_by, submitted_at
        FROM dispute_evidence WHERE dispute_id = $1::uuid ORDER BY submitted_at DESC
    `, [id]).catch(() => []);

    return NextResponse.json({ dispute, evidence });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const schema = z.object({
  to:    z.enum(["REPRESENTMENT","ACCEPTED","WON","LOST","EXPIRED"]),
  notes: z.string().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const result = await transitionDispute({
      disputeId: id, to: body.to as DisputeState,
      actorEmail: s.email, notes: body.notes,
    });
    await wormAppend({
      actorId: s.user_id, actorEmail: s.email,
      action: `dispute.${body.to.toLowerCase()}`,
      resourceType: "dispute", resourceId: id,
      before: { status: result.from }, after: { status: result.to, resolution_journal_id: result.resolution_journal_id },
      notes: body.notes,
    }).catch(() => null);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg = (err as Error).message;
    if (/cannot transition|dispute not found/.test(msg))
      return NextResponse.json({ error: msg }, { status: 409 });
    const e = pgError(err); return NextResponse.json(e.body, { status: e.status });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // POST attaches evidence: { evidence_type, file_url?, notes? }
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;
  const body = await req.json().catch(() => ({})) as { evidence_type?: string; file_url?: string; notes?: string };
  if (!body.evidence_type) return NextResponse.json({ error: "evidence_type required" }, { status: 400 });
  try {
    const r = await rows<{ evidence_id: string }>("riskVelocity", `
      INSERT INTO dispute_evidence (dispute_id, evidence_type, file_url, notes, submitted_by)
      VALUES ($1::uuid, $2, $3, $4, $5)
      RETURNING evidence_id::text
    `, [id, body.evidence_type, body.file_url ?? null, body.notes ?? null, s.email]);
    return NextResponse.json({ evidence_id: r[0].evidence_id });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
