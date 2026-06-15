// Persona policy: SUPER_ADMIN only (PRODUCT_VISION §3.11).
// Reads auditservice_db.audit_events (hash-chained append-only).

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 1000);
  const resourceType = url.searchParams.get("resource_type");

  try {
    const params: unknown[] = ["tenant-default"];
    let where = "tenant_id = $1";
    if (resourceType) { where += ` AND resource_type = $${params.length + 1}`; params.push(resourceType); }
    const events = await rows<any>("audit", `
      SELECT event_id::text, tenant_id, actor_subject, actor_type, action,
             resource_type, resource_id, occurred_at,
             COALESCE(trace_id,'') AS trace_id, metadata
        FROM audit_events
       WHERE ${where}
       ORDER BY occurred_at DESC LIMIT ${limit}
    `, params).catch(() => []);
    return NextResponse.json({ events });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
