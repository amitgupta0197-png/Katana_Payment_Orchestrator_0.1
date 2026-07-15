// POST /api/v1/dt/refills/{id} — drive a refill request's lifecycle (BRD §16):
// OPEN → FUNDED → VERIFIED → CLOSED, with CANCELLED allowed while not yet verified.
// Admin/Finance-side only; bankers raise requests but never transition them.
import { NextResponse } from "next/server";
import { z } from "zod";
import { gateOrResponse } from "@/lib/scope";
import { rows } from "@/lib/pg";
import { auditDt } from "@/lib/dt";

export const dynamic = "force-dynamic";

const NEXT: Record<string, string[]> = {
  OPEN: ["FUNDED", "CANCELLED"],
  FUNDED: ["VERIFIED", "CANCELLED"],
  VERIFIED: ["CLOSED"],
};

const schema = z.object({ to: z.enum(["FUNDED", "VERIFIED", "CLOSED", "CANCELLED"]) });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "FINANCE"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  const cur = await rows<{ status: string; banker_id: string }>("provider",
    `SELECT status, banker_id FROM dt_refill_requests WHERE id = $1::uuid`, [id]).catch(() => []);
  if (!cur.length) return NextResponse.json({ error: "refill request not found" }, { status: 404 });
  if (!(NEXT[cur[0].status] ?? []).includes(body.to))
    return NextResponse.json({ error: `cannot move ${cur[0].status} → ${body.to}` }, { status: 409 });
  await rows("provider", `UPDATE dt_refill_requests SET status = $2 WHERE id = $1::uuid`, [id, body.to]);
  await auditDt(g.session.email, `REFILL_${body.to}`, "dt_refill_request", id,
    { status: cur[0].status }, { status: body.to, banker_id: cur[0].banker_id });
  return NextResponse.json({ ok: true });
}
