// Incident lifecycle (BRD §13 P9 + §14 P10).
//
//   OPEN → INVESTIGATING → MITIGATING → RESOLVED → POST_MORTEM
//
// openIncidentIfMissing()  — used by SLO evaluator to auto-open one incident
//                             per (source + related target) so a sustained
//                             breach doesn't flood the list.

import { rows } from "@/lib/pg";
import { publish } from "@/lib/events";

export type IncidentStatus = "OPEN" | "INVESTIGATING" | "MITIGATING" | "RESOLVED" | "POST_MORTEM";

const ALLOWED: Record<IncidentStatus, IncidentStatus[]> = {
  OPEN:           ["INVESTIGATING", "MITIGATING", "RESOLVED"],
  INVESTIGATING:  ["MITIGATING", "RESOLVED"],
  MITIGATING:     ["RESOLVED"],
  RESOLVED:       ["POST_MORTEM"],
  POST_MORTEM:    [],
};

export interface OpenInput {
  severity: "SEV1" | "SEV2" | "SEV3" | "SEV4";
  source: "slo_breach" | "manual" | "risk" | "webhook_dlq" | "recon_sla";
  title: string;
  summary?: string;
  related_target?: string;
  related_entities?: Record<string, unknown>;
  openedBy?: string | null;
}

export async function openIncidentIfMissing(input: OpenInput): Promise<{
  incident_id: string; created: boolean;
}> {
  const dupe = await rows<{ incident_id: string }>("audit", `
    SELECT incident_id::text FROM incidents
     WHERE source=$1 AND related_target IS NOT DISTINCT FROM $2::uuid
       AND status IN ('OPEN','INVESTIGATING','MITIGATING')
     LIMIT 1
  `, [input.source, input.related_target ?? null]).catch(() => []);
  if (dupe.length) return { incident_id: dupe[0].incident_id, created: false };

  const r = await rows<{ incident_id: string }>("audit", `
    INSERT INTO incidents
      (severity, source, title, summary, related_target, related_entities, opened_by)
    VALUES ($1, $2, $3, $4, $5::uuid, $6::jsonb, $7)
    RETURNING incident_id::text
  `, [input.severity, input.source, input.title, input.summary ?? null,
      input.related_target ?? null,
      JSON.stringify(input.related_entities ?? {}),
      input.openedBy ?? null]);
  await publish({
    eventType: "risk.alert", producer: "risk_engine",
    entityType: "incident", entityId: r[0].incident_id, actorId: null,
    payload: { kind: "incident_opened", severity: input.severity, source: input.source, title: input.title },
  });
  return { incident_id: r[0].incident_id, created: true };
}

export async function transitionIncident(input: {
  incidentId: string; to: IncidentStatus; actorEmail?: string | null; notes?: string;
}): Promise<{ from: IncidentStatus; to: IncidentStatus }> {
  const cur = await rows<any>("audit",
    "SELECT status FROM incidents WHERE incident_id=$1::uuid", [input.incidentId]);
  if (!cur.length) throw new Error("incident not found");
  const from = cur[0].status as IncidentStatus;
  if (!ALLOWED[from]?.includes(input.to))
    throw new Error(`cannot transition ${from} → ${input.to}`);
  const isResolved = input.to === "RESOLVED";
  const sets: string[] = ["status=$1"];
  const args: unknown[] = [input.to];
  if (isResolved) {
    sets.push("resolved_at=now()");
    args.push(input.actorEmail ?? null); sets.push(`resolved_by=$${args.length}`);
    args.push(input.notes ?? null);      sets.push(`resolution_notes=$${args.length}`);
  } else if (input.to === "INVESTIGATING") {
    sets.push("acked_at=now()");
  }
  args.push(input.incidentId);
  await rows("audit",
    `UPDATE incidents SET ${sets.join(", ")} WHERE incident_id=$${args.length}::uuid`,
    args);
  await publish({
    eventType: "risk.alert", producer: "risk_engine",
    entityType: "incident", entityId: input.incidentId, actorId: null,
    payload: { kind: "incident_transition", from, to: input.to },
  });
  return { from, to: input.to };
}

export async function listIncidents(filter: { status?: string; severity?: string } = {}) {
  const where: string[] = []; const params: unknown[] = [];
  if (filter.status)   { params.push(filter.status);   where.push(`status = $${params.length}`); }
  if (filter.severity) { params.push(filter.severity); where.push(`severity = $${params.length}`); }
  return rows<any>("audit", `
    SELECT incident_id::text, severity, status, source,
           title, COALESCE(summary,'') AS summary,
           related_target::text, related_entities,
           opened_at, COALESCE(opened_by,'') AS opened_by,
           acked_at, resolved_at,
           COALESCE(resolved_by,'') AS resolved_by,
           COALESCE(resolution_notes,'') AS resolution_notes
      FROM incidents
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY (status IN ('OPEN','INVESTIGATING','MITIGATING')) DESC,
              severity ASC, opened_at DESC LIMIT 200
  `, params);
}
