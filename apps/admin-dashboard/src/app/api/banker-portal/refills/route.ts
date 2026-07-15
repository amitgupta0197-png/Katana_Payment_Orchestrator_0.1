// GET  /api/banker-portal/refills — the banker's own refill requests.
// POST /api/banker-portal/refills — banker raises a manual refill request for itself
// (BRD §16). banker_id always comes from the session scope, never from the body.
import { NextResponse } from "next/server";
import { z } from "zod";
import { gateOrResponse } from "@/lib/scope";
import { rows } from "@/lib/pg";
import { auditDt } from "@/lib/dt";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["BANKER"]);
  if ("response" in g) return g.response;
  const bankerId = g.session.scope_id;
  if (!bankerId) return NextResponse.json({ error: "BANKER session missing scope_id" }, { status: 400 });
  const refills = await rows<any>("provider", `
    SELECT id::text, banker_id, quantity::float AS quantity, trigger, status, expiry,
           COALESCE(created_by,'') AS created_by, created_at
      FROM dt_refill_requests WHERE banker_id = $1
     ORDER BY created_at DESC LIMIT 200
  `, [bankerId]).catch(() => []);
  return NextResponse.json({ refills });
}

const schema = z.object({ quantity: z.number().positive().optional() });

export async function POST(req: Request) {
  const g = await gateOrResponse(["BANKER"]);
  if ("response" in g) return g.response;
  const bankerId = g.session.scope_id;
  if (!bankerId) return NextResponse.json({ error: "BANKER session missing scope_id" }, { status: 400 });
  let body;
  try { body = schema.parse(await req.json().catch(() => ({}))); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  const r = await rows<{ id: string }>("provider", `
    INSERT INTO dt_refill_requests (banker_id, quantity, trigger, status, created_by)
    VALUES ($1,$2,'MANUAL','OPEN',$3) RETURNING id::text
  `, [bankerId, body.quantity ?? null, g.session.email]);
  await auditDt(g.session.email, "REFILL_CREATE", "dt_refill_request", r[0].id, null, { banker_id: bankerId, ...body });
  return NextResponse.json({ ok: true, id: r[0].id });
}
