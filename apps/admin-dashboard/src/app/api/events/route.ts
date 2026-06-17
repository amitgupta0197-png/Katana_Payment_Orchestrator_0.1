// GET /api/events — event-stream feed for Super Admin (BRD §16).
// Filters: ?type=<event_type>&entity_type=&entity_id=&limit=

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;

  const url = new URL(req.url);
  const type = url.searchParams.get("type");
  const entityType = url.searchParams.get("entity_type");
  const entityId = url.searchParams.get("entity_id");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 1000);

  const where: string[] = ["tenant_id = $1"];
  const params: unknown[] = ["tenant-default"];
  if (type) { where.push(`event_type = $${params.length + 1}`); params.push(type); }
  if (entityType) { where.push(`entity_type = $${params.length + 1}`); params.push(entityType); }
  if (entityId) { where.push(`entity_id = $${params.length + 1}`); params.push(entityId); }

  try {
    const events = await rows<any>("audit", `
      SELECT event_id::text, event_type, producer, entity_type, entity_id,
             actor_id, payload, created_at
        FROM event_stream
       WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT ${limit}
    `, params);
    return NextResponse.json({ events });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
