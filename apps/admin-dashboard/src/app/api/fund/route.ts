// SUPER_ADMIN R + initiate; others ✗ (PRODUCT_VISION §3.11).
// Surfaces platform-level treasury — vendor balance snapshots + bank statements.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  try {
    const vendor_balances = await rows<any>("vendorGateway", `
      SELECT id::text, vendor, env, balance, currency, captured_at
        FROM vendor_balance_snapshots ORDER BY captured_at DESC LIMIT 100
    `).catch(() => []);
    const recent_bank_statements = await rows<any>("bankAdapter", `
      SELECT id::text, rail_code, account_no, amount, currency, direction, value_date
        FROM bank_statements ORDER BY value_date DESC LIMIT 100
    `).catch(() => []);
    return NextResponse.json({ vendor_balances, recent_bank_statements });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
