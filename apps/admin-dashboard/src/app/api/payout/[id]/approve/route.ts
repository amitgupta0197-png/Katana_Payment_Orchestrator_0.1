// POST /api/payout/[id]/approve — SUPER_ADMIN approves / rejects a payout.
import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

const schema = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
  notes: z.string().optional().default(""),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const newStatus = body.decision === "APPROVED" ? "DISPATCHED" : "REJECTED";
    const res = await rows<any>("payout", `
      UPDATE payouts SET status = $1, updated_at = now()
       WHERE id = $2::uuid AND status IN ('PENDING','APPROVED')
       RETURNING id::text, status, updated_at
    `, [newStatus, id]);
    if (!res.length) return NextResponse.json({ error: "payout not pending" }, { status: 409 });
    await rows("payout", `
      INSERT INTO payout_approvals (payout_id, decision, actor, notes, decided_at)
      VALUES ($1::uuid, $2, $3, $4, now())
    `, [id, body.decision, s.email, body.notes]).catch(() => {});
    return NextResponse.json(res[0]);
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
