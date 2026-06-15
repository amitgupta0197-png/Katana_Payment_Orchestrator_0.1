// Persona policy: SUPER_ADMIN R; PROVIDER/MERCHANT R scoped.
import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse, resolveProviderMerchants } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;
  try {
    const params: unknown[] = ["tenant-default"];
    let where = "tenant_id = $1";
    if (s.persona === "MERCHANT") { where += ` AND reference = $${params.length + 1}`; params.push(s.scope_id); }
    else if (s.persona === "PROVIDER") {
      const ids = await resolveProviderMerchants(s);
      if (!ids.length) return NextResponse.json({ breaks: [] });
      where += ` AND reference = ANY($${params.length + 1}::text[])`; params.push(ids);
    }
    const breaks = await rows<any>("reconciliation", `
      SELECT id::text, run_id::text, tenant_id, reference, break_type, sources_present,
             amount, currency, delta, status, COALESCE(assignee,'') AS assignee,
             COALESCE(notes,'') AS notes, opened_at, resolved_at
        FROM recon_breaks
       WHERE ${where}
       ORDER BY opened_at DESC LIMIT 200
    `, params).catch(() => []);
    return NextResponse.json({ breaks });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
