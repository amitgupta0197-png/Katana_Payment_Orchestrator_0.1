// SUPER_ADMIN only.
import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  try {
    const vasps = await rows<any>("cryptoRail", `
      SELECT id::text, code, name, kind, enabled, spread_bps, created_at
        FROM vasps ORDER BY code LIMIT 100
    `).catch(() => []);
    const recent_transfers = await rows<any>("cryptoRail", `
      SELECT id::text, vasp_code, network, txid, amount, currency, status, created_at
        FROM crypto_transfers ORDER BY created_at DESC LIMIT 50
    `).catch(() => []);
    return NextResponse.json({ vasps, recent_transfers });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
