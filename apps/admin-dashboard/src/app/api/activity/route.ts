// Per-entity activity feed. Reads worm_audit_log filtered by (resource_type,
// resource_id). Available to any authenticated persona — caller should only
// link to entities the persona can already read; this endpoint is read-only.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;

  const url = new URL(req.url);
  const resource_type = url.searchParams.get("resource_type");
  const resource_id = url.searchParams.get("resource_id");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);

  if (!resource_type || !resource_id) {
    return NextResponse.json({ error: "resource_type and resource_id are required" }, { status: 400 });
  }

  try {
    const events = await rows<any>(
      "audit",
      `SELECT log_id::text AS id,
              COALESCE(actor_email, actor_id, 'system') AS actor,
              action,
              resource_type,
              resource_id,
              COALESCE(notes,'') AS notes,
              COALESCE(before_value, '{}'::jsonb) AS before_value,
              COALESCE(after_value,  '{}'::jsonb) AS after_value,
              created_at AS at
         FROM worm_audit_log
        WHERE tenant_id = $1 AND resource_type = $2 AND resource_id = $3
        ORDER BY created_at DESC
        LIMIT ${limit}`,
      ["tenant-default", resource_type, resource_id],
    ).catch(() => []);
    return NextResponse.json({ events });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
