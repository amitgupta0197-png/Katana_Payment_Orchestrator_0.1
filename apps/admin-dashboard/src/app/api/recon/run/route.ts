// POST /api/recon/run — run the three-way reconciliation matcher.
// Body: { window_start?, window_end? } (defaults to last 24h)

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { runReconciliation } from "@/lib/reconciliation";
import { publish } from "@/lib/events";

export const dynamic = "force-dynamic";

const schema = z.object({
  window_start: z.string().optional(),
  window_end: z.string().optional(),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;
  let body: z.infer<typeof schema>;
  try { body = schema.parse(await req.json().catch(() => ({}))); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const end = body.window_end ? new Date(body.window_end) : new Date();
    const start = body.window_start ? new Date(body.window_start) : new Date(end.getTime() - 24 * 60 * 60 * 1000);
    const result = await runReconciliation({ windowStart: start, windowEnd: end });
    if (result.breaks_opened > 0) {
      await publish({
        eventType: "reconciliation.break_opened", producer: "reconciliation",
        entityType: "recon_run", entityId: result.run_id, actorId: s.user_id,
        payload: result,
      });
    }
    return NextResponse.json(result);
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
