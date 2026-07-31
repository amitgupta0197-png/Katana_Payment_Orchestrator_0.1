// GET /api/v1/dt/audit — the DT audit trail (BRD §9 "DT Audit Trail", §18 audit_logs).
// Every DT mutation writes here via auditDt(); this is the read side. Supports optional
// ?entity= / ?action= / ?actor= narrowing so an investigator can follow one lot or one
// operator without scrolling the whole log.
import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { rows } from "@/lib/pg";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "FINANCE", "RISK"]);
  if ("response" in g) return g.response;

  const url = new URL(req.url);
  const entity = url.searchParams.get("entity")?.trim() || null;
  const action = url.searchParams.get("action")?.trim() || null;
  const actor = url.searchParams.get("actor")?.trim() || null;
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 500) || 500, 1), 1000);

  // Parameterised NULL-guards rather than string-built WHERE — keeps one plan and
  // keeps the filters injection-safe.
  const entries = await rows<any>("provider", `
    SELECT id::text, COALESCE(actor,'') AS actor, action, entity,
           COALESCE(entity_id,'') AS entity_id, before, after,
           COALESCE(correlation_id,'') AS correlation_id, created_at
      FROM dt_audit_logs
     WHERE ($1::text IS NULL OR entity = $1)
       AND ($2::text IS NULL OR action = $2)
       AND ($3::text IS NULL OR actor  = $3)
     ORDER BY created_at DESC
     LIMIT $4
  `, [entity, action, actor, limit]).catch(() => []);

  // Distinct values drive the UI's filter chips without a second round trip.
  const facets = await rows<any>("provider", `
    SELECT 'entity' AS kind, entity AS value FROM dt_audit_logs GROUP BY entity
    UNION ALL
    SELECT 'action' AS kind, action AS value FROM dt_audit_logs GROUP BY action
  `).catch(() => []);

  return NextResponse.json({
    entries,
    entities: facets.filter((f) => f.kind === "entity").map((f) => f.value).sort(),
    actions: facets.filter((f) => f.kind === "action").map((f) => f.value).sort(),
  });
}
