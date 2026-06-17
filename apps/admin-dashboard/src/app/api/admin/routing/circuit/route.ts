// POST /api/admin/routing/circuit — manual circuit-breaker actions.
// Body: { provider, action: "reset" | "trip" }

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { resetCircuit } from "@/lib/circuit-breaker";
import { wormAppend } from "@/lib/worm";

export const dynamic = "force-dynamic";

const schema = z.object({
  provider: z.string().min(1),
  action: z.enum(["reset", "trip"]),
  reason: z.string().optional(),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  const provider = body.provider.toUpperCase();
  try {
    const before = (await rows<any>("routingEngine",
      "SELECT circuit_state, consecutive_failures FROM provider_health_snapshot WHERE provider_code=$1",
      [provider]))[0];
    if (!before) return NextResponse.json({ error: "provider not found in health snapshot" }, { status: 404 });

    if (body.action === "reset") {
      await resetCircuit(provider);
    } else {
      await rows("routingEngine", `
        UPDATE provider_health_snapshot
           SET circuit_state='OPEN', circuit_opened_at=now(),
               consecutive_failures = GREATEST(consecutive_failures, 999),
               updated_at=now()
         WHERE provider_code=$1
      `, [provider]);
    }
    const after = (await rows<any>("routingEngine",
      "SELECT circuit_state, consecutive_failures FROM provider_health_snapshot WHERE provider_code=$1",
      [provider]))[0];

    await wormAppend({
      actorId: s.user_id, actorEmail: s.email,
      action: `routing.circuit.${body.action}`,
      resourceType: "provider_circuit", resourceId: provider,
      before, after, notes: body.reason,
    }).catch(() => null);
    return NextResponse.json({ ok: true, provider, ...after });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
