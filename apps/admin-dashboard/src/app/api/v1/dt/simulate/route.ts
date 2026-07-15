// POST /api/v1/dt/simulate — run one order through the DT engine end-to-end
// (reserve → consume/release → commission → shadow journal). This is the shadow/pilot
// harness (BRD Migration §23) — it exercises the DT tables only and does NOT affect live
// pay-in routing. SUPER_ADMIN only.
import { NextResponse } from "next/server";
import { z } from "zod";
import { gateOrResponse } from "@/lib/scope";
import { processOrder } from "@/lib/dt-engine";

export const dynamic = "force-dynamic";

const schema = z.object({
  order_ref: z.string().trim().min(1).max(120),
  banker_id: z.string().trim().min(1).max(120),
  amount: z.number().positive(),
  outcome: z.enum(["SUCCESS", "FAILURE"]).default("SUCCESS"),
  merchant_group: z.string().optional(),
  branch: z.string().optional(),
  channel: z.string().optional(),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  let body; try { body = schema.parse(await req.json()); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  const result = await processOrder({ ...body, actor: g.session.email });
  return NextResponse.json({ ok: true, result });
}
