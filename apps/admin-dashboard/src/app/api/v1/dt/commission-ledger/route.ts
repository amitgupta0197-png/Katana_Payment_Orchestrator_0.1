// GET /api/v1/dt/commission-ledger — per-transaction commission accrual (the waterfall).
import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { rows } from "@/lib/pg";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "FINANCE", "RISK"]);
  if ("response" in g) return g.response;
  const entries = await rows<any>("provider", `
    SELECT id::text, transaction_ref, base_amount::float AS base_amount,
           merchant_charge::float AS merchant_charge, banker_commission::float AS banker_commission,
           katana_margin::float AS katana_margin, rule_version,
           (reversal_of IS NOT NULL) AS is_reversal, created_at
      FROM commission_entries ORDER BY created_at DESC LIMIT 500
  `).catch(() => []);
  const [tot] = await rows<any>("provider", `
    SELECT COALESCE(SUM(merchant_charge),0)::float AS merchant_charge,
           COALESCE(SUM(banker_commission),0)::float AS banker_commission,
           COALESCE(SUM(katana_margin),0)::float AS katana_margin FROM commission_entries
  `).catch(() => [{}]);
  return NextResponse.json({ entries, totals: tot });
}
