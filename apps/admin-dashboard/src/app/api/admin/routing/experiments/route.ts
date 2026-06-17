// GET  /api/admin/routing/experiments    — list
// POST /api/admin/routing/experiments    — create / upsert
// PATCH /api/admin/routing/experiments?id=... — enable / disable
//
// BRD §6 P2 upgrade: A/B testing.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { DEFAULT_WEIGHTS } from "@/lib/routing";

export const dynamic = "force-dynamic";

const weightsSchema = z.object({
  success_rate: z.number(), latency: z.number(), cost: z.number(),
  health: z.number(), risk: z.number(),
  failure_penalty: z.number(), capacity_penalty: z.number(),
});

const createSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().optional(),
  control_weights: weightsSchema.default(DEFAULT_WEIGHTS),
  variant_weights: weightsSchema,
  traffic_split: z.number().min(0).max(1).default(0.5),
  method_scope: z.string().optional(),
  enabled: z.boolean().default(false),
});

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  try {
    const experiments = await rows<any>("routingEngine", `
      SELECT experiment_id::text, name, description,
             control_weights, variant_weights, traffic_split::float AS traffic_split,
             method_scope, enabled, started_at, ended_at, created_at,
             COALESCE(created_by,'') AS created_by
        FROM routing_experiments
       ORDER BY enabled DESC, created_at DESC
    `);
    // Per-experiment success counts from routing_decisions (winner + bucket).
    const stats = await rows<any>("routingEngine", `
      SELECT experiment_id::text, experiment_bucket, COUNT(*)::int AS picks,
             AVG(score)::float AS avg_score
        FROM routing_decisions
       WHERE experiment_id IS NOT NULL
       GROUP BY experiment_id, experiment_bucket
    `);
    return NextResponse.json({ experiments, stats });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;
  let body;
  try { body = createSchema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const ins = await rows<any>("routingEngine", `
      INSERT INTO routing_experiments
        (name, description, control_weights, variant_weights, traffic_split,
         method_scope, enabled, started_at, created_by)
      VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7,
              CASE WHEN $7 THEN now() ELSE NULL END, $8)
      ON CONFLICT (name) DO UPDATE SET
        description=EXCLUDED.description,
        control_weights=EXCLUDED.control_weights,
        variant_weights=EXCLUDED.variant_weights,
        traffic_split=EXCLUDED.traffic_split,
        method_scope=EXCLUDED.method_scope,
        enabled=EXCLUDED.enabled,
        started_at=COALESCE(routing_experiments.started_at, EXCLUDED.started_at),
        ended_at = CASE WHEN EXCLUDED.enabled THEN NULL ELSE routing_experiments.ended_at END
      RETURNING experiment_id::text, name, enabled, traffic_split::float AS traffic_split
    `, [body.name, body.description ?? null,
        JSON.stringify(body.control_weights), JSON.stringify(body.variant_weights),
        body.traffic_split, body.method_scope?.toUpperCase() ?? null,
        body.enabled, s.email]);
    return NextResponse.json({ ok: true, experiment: ins[0] });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const patchSchema = z.object({ enabled: z.boolean() });

export async function PATCH(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "missing ?id" }, { status: 400 });
  let body;
  try { body = patchSchema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const r = await rows<any>("routingEngine", `
      UPDATE routing_experiments
         SET enabled=$1,
             started_at = CASE WHEN $1 AND started_at IS NULL THEN now() ELSE started_at END,
             ended_at   = CASE WHEN NOT $1 THEN now() ELSE NULL END
       WHERE experiment_id=$2::uuid
       RETURNING experiment_id::text, name, enabled
    `, [body.enabled, id]);
    if (!r.length) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ ok: true, experiment: r[0] });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
