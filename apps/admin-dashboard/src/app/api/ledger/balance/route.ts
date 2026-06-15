// Persona policy (PRODUCT_VISION §3.11):
//   SUPER_ADMIN — R + verify.
//   PROVIDER    — R mapped.
//   MERCHANT    — R own.

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
    if (s.persona === "MERCHANT") {
      where += ` AND merchant_id = $${params.length + 1}`;
      params.push(s.scope_id);
    } else if (s.persona === "PROVIDER") {
      const ids = await resolveProviderMerchants(s);
      if (!ids.length) return NextResponse.json({ balances: [] });
      where += ` AND merchant_id = ANY($${params.length + 1}::text[])`;
      params.push(ids);
    }
    const balances = await rows<any>("ledger", `
      SELECT merchant_id, currency,
             SUM(CASE WHEN side = 'CREDIT' THEN amount ELSE 0 END)
               - SUM(CASE WHEN side = 'DEBIT' THEN amount ELSE 0 END) AS balance
        FROM journal_entries
       WHERE ${where}
       GROUP BY merchant_id, currency
       ORDER BY merchant_id
    `, params).catch(() => []);
    return NextResponse.json({ balances });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
