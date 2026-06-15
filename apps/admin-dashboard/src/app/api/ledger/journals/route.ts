// Persona policy (PRODUCT_VISION §3.11): SUPER_ADMIN R+verify; PROVIDER/MERCHANT R scoped.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse, resolveProviderMerchants } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 1000);

  try {
    const params: unknown[] = ["tenant-default"];
    let extra = "";
    if (s.persona === "MERCHANT") { extra = ` AND ref_id = $${params.length + 1}`; params.push(s.scope_id); }
    else if (s.persona === "PROVIDER") {
      const ids = await resolveProviderMerchants(s);
      if (!ids.length) return NextResponse.json({ journals: [] });
      extra = ` AND ref_id = ANY($${params.length + 1}::text[])`; params.push(ids);
    }
    const journals = await rows<any>("ledger", `
      SELECT id::text, tenant_id, posted_at, currency, narration,
             COALESCE(ref_type,'') AS ref_type, COALESCE(ref_id,'') AS ref_id,
             COALESCE(idempotency_key,'') AS idempotency_key
        FROM journal_entries
       WHERE tenant_id = $1 ${extra}
       ORDER BY posted_at DESC LIMIT ${limit}
    `, params).catch(() => []);
    return NextResponse.json({ journals });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
