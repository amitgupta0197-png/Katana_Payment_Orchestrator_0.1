// Persona policy: SUPER_ADMIN only (PRODUCT_VISION §3.11).
// Reads from worm_audit_log (BRD §15) — hash-chained, append-only.
// Falls back to legacy audit_events if WORM is empty.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { wormVerify } from "@/lib/worm";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 1000);
  const resourceType = url.searchParams.get("resource_type");
  const verify = url.searchParams.get("verify") === "1";

  try {
    const params: unknown[] = ["tenant-default"];
    let where = "tenant_id = $1";
    if (resourceType) { where += ` AND resource_type = $${params.length + 1}`; params.push(resourceType); }

    const worm = await rows<any>("audit", `
      SELECT log_id::text AS event_id,
             tenant_id,
             COALESCE(actor_email, actor_id, '') AS actor_subject,
             'USER' AS actor_type,
             action,
             resource_type,
             resource_id,
             created_at AS occurred_at,
             prev_hash,
             hash,
             COALESCE(before_value, '{}'::jsonb) AS before_value,
             COALESCE(after_value, '{}'::jsonb) AS after_value,
             COALESCE(notes,'') AS notes
        FROM worm_audit_log
       WHERE ${where}
       ORDER BY created_at DESC LIMIT ${limit}
    `, params).catch(() => []);

    if (worm.length > 0) {
      const integrity = verify ? await wormVerify().catch(() => null) : null;
      return NextResponse.json({ events: worm, source: "worm", integrity });
    }

    // Fallback to legacy table for back-compat.
    const events = await rows<any>("audit", `
      SELECT event_id::text, tenant_id, actor_subject, actor_type, action,
             resource_type, resource_id, occurred_at,
             COALESCE(trace_id,'') AS trace_id, metadata
        FROM audit_events
       WHERE ${where}
       ORDER BY occurred_at DESC LIMIT ${limit}
    `, params).catch(() => []);
    return NextResponse.json({ events, source: "audit_events" });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
