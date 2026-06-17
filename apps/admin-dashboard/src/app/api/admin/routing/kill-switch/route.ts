// POST /api/admin/routing/kill-switch — flip rail.kill_switch.
// Body: { provider, method, direction?, on, reason? }
// WORM-logged.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { wormAppend } from "@/lib/worm";
import { publish } from "@/lib/events";

export const dynamic = "force-dynamic";

const schema = z.object({
  provider: z.string().min(1),
  method:   z.string().min(1),
  direction: z.enum(["PAYIN", "PAYOUT"]).default("PAYIN"),
  on:       z.boolean(),
  reason:   z.string().optional(),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  try {
    const before = (await rows<any>("routingEngine",
      `SELECT provider, method, direction, kill_switch FROM rails
        WHERE provider=$1 AND method=$2 AND direction=$3`,
      [body.provider.toUpperCase(), body.method.toUpperCase(), body.direction]))[0];
    if (!before) return NextResponse.json({ error: "rail not found" }, { status: 404 });

    const upd = await rows<any>("routingEngine", `
      UPDATE rails
         SET kill_switch=$1,
             kill_switch_reason = CASE WHEN $1 THEN $2 ELSE NULL END,
             kill_switch_at     = CASE WHEN $1 THEN now() ELSE NULL END,
             kill_switch_by     = CASE WHEN $1 THEN $3   ELSE NULL END
       WHERE provider=$4 AND method=$5 AND direction=$6
       RETURNING provider, method, direction, kill_switch
    `, [body.on, body.reason ?? "operator action", s.email,
        body.provider.toUpperCase(), body.method.toUpperCase(), body.direction]);

    await wormAppend({
      actorId: s.user_id, actorEmail: s.email,
      action: body.on ? "routing.kill_switch.on" : "routing.kill_switch.off",
      resourceType: "rail",
      resourceId: `${body.provider.toUpperCase()}/${body.method.toUpperCase()}/${body.direction}`,
      before: { kill_switch: before.kill_switch },
      after: { kill_switch: body.on, reason: body.reason },
    }).catch(() => null);

    await publish({
      eventType: "risk.alert", producer: "routing_engine",
      entityType: "rail", entityId: `${body.provider}:${body.method}:${body.direction}`,
      actorId: s.user_id,
      payload: { kind: "kill_switch", on: body.on, reason: body.reason ?? null },
    });

    return NextResponse.json({ ok: true, rail: upd[0] });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
