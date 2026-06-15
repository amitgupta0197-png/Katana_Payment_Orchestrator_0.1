// SUPER_ADMIN updates chargeback case state per state machine in PRODUCT_VISION §4.
import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

const schema = z.object({
  status: z.enum(["IN_REVIEW", "ACCEPTED", "DISPUTED", "WON", "LOST", "EXPIRED"]),
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
    const res = await rows<any>("riskVelocity", `
      UPDATE chargebacks SET status = $1, updated_at = now()
       WHERE id = $2::uuid RETURNING id::text, status, updated_at
    `, [body.status, id]);
    if (!res.length) return NextResponse.json({ error: "not found" }, { status: 404 });
    await rows("riskVelocity", `
      INSERT INTO chargeback_events (chargeback_id, kind, actor, notes, created_at)
      VALUES ($1::uuid, $2, $3, $4, now())
    `, [id, body.status, s.email, body.notes]).catch(() => {});
    return NextResponse.json(res[0]);
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
