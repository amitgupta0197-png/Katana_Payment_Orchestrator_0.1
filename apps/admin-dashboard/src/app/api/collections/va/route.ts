// SUPER_ADMIN CRUD; PROVIDER R mapped; MERCHANT R own.
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
    if (s.persona === "MERCHANT") { where += ` AND counterparty = $${params.length + 1}`; params.push(s.scope_id); }
    else if (s.persona === "PROVIDER") {
      const ids = await resolveProviderMerchants(s);
      if (!ids.length) return NextResponse.json({ accounts: [] });
      where += ` AND counterparty = ANY($${params.length + 1}::text[])`; params.push(ids);
    }
    const accounts = await rows<any>("collections", `
      SELECT id::text, tenant_id, counterparty, bank, va_account_no, va_ifsc,
             COALESCE(va_upi_vpa,'') AS va_upi_vpa, purpose, active, created_at
        FROM virtual_accounts WHERE ${where}
       ORDER BY created_at DESC LIMIT 200
    `, params).catch(() => []);
    return NextResponse.json({ accounts });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
