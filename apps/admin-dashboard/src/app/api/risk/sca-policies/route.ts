// GET  /api/risk/sca-policies — list active policies.
// POST /api/risk/sca-policies — create / upsert.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  try {
    const policies = await rows<any>("riskVelocity", `
      SELECT policy_id::text, merchant_id, country, method,
             always_challenge, challenge_above_minor::text AS challenge_above_minor,
             trusted_beneficiary_threshold_minor::text AS trusted_beneficiary_threshold_minor,
             risk_score_threshold::float AS risk_score_threshold,
             enabled, created_at
        FROM sca_policies
       ORDER BY enabled DESC, created_at DESC
    `);
    return NextResponse.json({ policies });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const schema = z.object({
  merchant_id: z.string().optional(),
  country: z.string().optional(),
  method: z.string().optional().default("CARD"),
  always_challenge: z.boolean().default(false),
  challenge_above_minor: z.number().int().nonnegative().default(300000),
  risk_score_threshold: z.number().min(0).max(1).default(0.6),
  trusted_beneficiary_threshold_minor: z.number().int().nonnegative().default(0),
  enabled: z.boolean().default(true),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const ins = await rows<any>("riskVelocity", `
      INSERT INTO sca_policies
        (merchant_id, country, method, always_challenge, challenge_above_minor,
         trusted_beneficiary_threshold_minor, risk_score_threshold, enabled)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING policy_id::text
    `, [body.merchant_id ?? null, body.country?.toUpperCase() ?? null, body.method.toUpperCase(),
        body.always_challenge, body.challenge_above_minor,
        body.trusted_beneficiary_threshold_minor, body.risk_score_threshold, body.enabled]);
    return NextResponse.json({ policy_id: ins[0].policy_id });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
