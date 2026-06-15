// SUPER_ADMIN R all; PROVIDER R mapped; MERCHANT R own (PRODUCT_VISION §3.11).
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
    if (s.persona === "MERCHANT") { where += ` AND merchant_id = $${params.length + 1}`; params.push(s.scope_id); }
    else if (s.persona === "PROVIDER") {
      const ids = await resolveProviderMerchants(s);
      if (!ids.length) return NextResponse.json({ daily: [], facts_recent: [] });
      where += ` AND merchant_id = ANY($${params.length + 1}::text[])`; params.push(ids);
    }
    const daily = await rows<any>("reporting", `
      SELECT tenant_id, merchant_id, kind, status, day, currency,
             txn_count, gross_amount, fee_amount, updated_at
        FROM merchant_daily WHERE ${where}
       ORDER BY day DESC, merchant_id LIMIT 200
    `, params).catch(() => []);
    const facts_recent = await rows<any>("reporting", `
      SELECT id::text, tenant_id, merchant_id, txn_id, kind, rail, method, amount, fee,
             currency, status, occurred_at
        FROM txn_facts WHERE ${where}
       ORDER BY occurred_at DESC LIMIT 100
    `, params).catch(() => []);
    return NextResponse.json({ daily, facts_recent });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
