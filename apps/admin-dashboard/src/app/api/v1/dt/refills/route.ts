// GET  /api/v1/dt/refills — refill requests (opened on low-balance/exhaustion, BRD §16).
// POST /api/v1/dt/refills — raise a manual refill request for a banker.
import { NextResponse } from "next/server";
import { z } from "zod";
import { gateOrResponse } from "@/lib/scope";
import { rows } from "@/lib/pg";
import { auditDt } from "@/lib/dt";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "FINANCE", "RISK"]);
  if ("response" in g) return g.response;
  const banker = new URL(req.url).searchParams.get("banker");
  const refills = await rows<any>("provider", `
    SELECT id::text, banker_id, allocation_id::text, quantity::float AS quantity,
           trigger, status, expiry, COALESCE(created_by,'') AS created_by, created_at
      FROM dt_refill_requests ${banker ? "WHERE banker_id = $1" : ""}
     ORDER BY created_at DESC LIMIT 500
  `, banker ? [banker] : []).catch(() => []);
  return NextResponse.json({ refills });
}

const schema = z.object({ banker_id: z.string().trim().min(1).max(120), quantity: z.number().positive().optional() });

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "FINANCE"]);
  if ("response" in g) return g.response;
  let body; try { body = schema.parse(await req.json()); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  const r = await rows<{ id: string }>("provider", `
    INSERT INTO dt_refill_requests (banker_id, quantity, trigger, status, created_by)
    VALUES ($1,$2,'MANUAL','OPEN',$3) RETURNING id::text
  `, [body.banker_id, body.quantity ?? null, g.session.email]);
  await auditDt(g.session.email, "REFILL_CREATE", "dt_refill_request", r[0].id, null, body);
  return NextResponse.json({ ok: true, id: r[0].id });
}
