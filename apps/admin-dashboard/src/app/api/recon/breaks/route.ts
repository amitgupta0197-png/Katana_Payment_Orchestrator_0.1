// Persona policy: SUPER_ADMIN R+W; PROVIDER/MERCHANT R scoped.
// Sprint 7 expansion: ageing_bucket, expected_action, evidence, assignee surfaced.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse, resolveProviderMerchants } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const ageing = url.searchParams.get("ageing_bucket");

  try {
    const params: unknown[] = ["tenant-default"];
    const wh: string[] = ["tenant_id = $1"];
    if (s.persona === "MERCHANT") { params.push(s.scope_id); wh.push(`reference = $${params.length}`); }
    else if (s.persona === "PROVIDER") {
      const ids = await resolveProviderMerchants(s);
      if (!ids.length) return NextResponse.json({ breaks: [] });
      params.push(ids); wh.push(`reference = ANY($${params.length}::text[])`);
    }
    if (status) { params.push(status); wh.push(`status = $${params.length}`); }
    if (ageing) { params.push(ageing); wh.push(`ageing_bucket = $${params.length}`); }
    const breaks = await rows<any>("reconciliation", `
      SELECT id::text, run_id::text, reference, break_type, sources_present,
             amount::text AS amount, currency, delta::text AS delta,
             status, COALESCE(assignee,'') AS assignee, COALESCE(notes,'') AS notes,
             COALESCE(ageing_bucket,'?') AS ageing_bucket,
             COALESCE(expected_action,'') AS expected_action,
             COALESCE(resolution_kind,'') AS resolution_kind,
             COALESCE(resolved_by,'') AS resolved_by,
             evidence, opened_at, resolved_at
        FROM recon_breaks
       WHERE ${wh.join(" AND ")}
       ORDER BY (status='OPEN') DESC,
                CASE ageing_bucket WHEN '7d+' THEN 1 WHEN '3-7d' THEN 2 WHEN '1-3d' THEN 3 ELSE 4 END,
                opened_at DESC LIMIT 300
    `, params).catch(() => []);

    // Summary buckets for the UI header.
    const summary = await rows<any>("reconciliation", `
      SELECT COALESCE(ageing_bucket,'?') AS ageing_bucket,
             COUNT(*)::int AS count
        FROM recon_breaks
       WHERE tenant_id='tenant-default' AND status IN ('OPEN','INVESTIGATING')
       GROUP BY ageing_bucket
    `).catch(() => []);

    return NextResponse.json({ breaks, summary });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
