// GET /api/admin/slos — current SLO values + status + history.
// On every read we compute fresh observations and auto-open incidents on
// BREACH.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { computeAll } from "@/lib/slo";
import { openIncidentIfMissing } from "@/lib/incidents";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  try {
    const results = await computeAll();
    for (const r of results) {
      if (r.status === "BREACH") {
        await openIncidentIfMissing({
          severity: r.target.metric_kind === "availability" ? "SEV1" : "SEV2",
          source: "slo_breach",
          title: `${r.target.name} BREACH`,
          summary: `${r.target.metric_kind}=${r.measured.toFixed(4)} target ${r.target.comparison} ${r.target.target_value}`,
          related_target: r.target.target_id,
          related_entities: { kind: r.target.metric_kind, detail: r.detail },
        }).catch(() => null);
      }
    }
    // Per-target observations history (last 30).
    const history = await rows<any>("audit", `
      SELECT target_id::text, measured_value::float AS measured_value,
             status, observed_at, detail
        FROM slo_observations
       WHERE observed_at > now() - interval '24 hours'
       ORDER BY observed_at DESC LIMIT 200
    `).catch(() => []);
    return NextResponse.json({ slos: results, history });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
