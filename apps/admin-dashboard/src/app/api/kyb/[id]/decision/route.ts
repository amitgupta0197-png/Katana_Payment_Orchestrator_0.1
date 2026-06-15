// POST /api/kyb/[id]/decision — SUPER_ADMIN-only KYB case approval/rejection.
import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

const schema = z.object({
  status: z.enum(["APPROVED", "REJECTED", "IN_REVIEW", "EXPIRED"]),
  risk_tier: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
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
    const sets: string[] = ["status = $1"];
    const args: unknown[] = [body.status];
    if (body.risk_tier) { args.push(body.risk_tier); sets.push(`risk_tier = $${args.length}`); }
    if (body.status === "APPROVED" || body.status === "REJECTED") {
      args.push(s.email);
      sets.push(`decided_by = $${args.length}`, `decided_at = now()`);
    }
    args.push(id);
    const res = await rows<any>("kybPayments", `
      UPDATE kyb_cases SET ${sets.join(", ")}
       WHERE id = $${args.length}::uuid
       RETURNING id::text, merchant_id, status, risk_tier, decided_at,
                 COALESCE(decided_by,'') AS decided_by
    `, args);
    if (!res.length) return NextResponse.json({ error: "not found" }, { status: 404 });
    await rows("kybPayments", `
      INSERT INTO kyb_decisions (case_id, decision, actor, notes, decided_at)
      VALUES ($1::uuid, $2, $3, $4, now())
    `, [id, body.status, s.email, body.notes]).catch(() => {});
    return NextResponse.json(res[0]);
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
