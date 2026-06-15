// SUPER_ADMIN only.
import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  try {
    const rails = await rows<any>("bankAdapter", `
      SELECT id::text, code, name, capabilities, health, created_at
        FROM bank_rails ORDER BY code LIMIT 100
    `).catch(() => []);
    const recent_disbursements = await rows<any>("bankAdapter", `
      SELECT id::text, rail_code, beneficiary_ifsc, beneficiary_account, amount, currency, status, created_at
        FROM bank_disbursements ORDER BY created_at DESC LIMIT 50
    `).catch(() => []);
    return NextResponse.json({ rails, recent_disbursements });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
