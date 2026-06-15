// SUPER_ADMIN-only chart of accounts.
import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  try {
    const accounts = await rows<any>("ledger", `
      SELECT id::text, tenant_id, code, COALESCE(parent_code,'') AS parent_code,
             type, currency, normal_balance, closed, created_at
        FROM accounts WHERE tenant_id = 'tenant-default'
       ORDER BY code LIMIT 500
    `).catch(() => []);
    return NextResponse.json({ accounts });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
