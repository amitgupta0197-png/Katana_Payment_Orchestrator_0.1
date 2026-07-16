// GET /api/v1/dt/wallets/{bankerId} — the banker's DT wallet (purchase lots, not one
// mutable balance) + traffic wallet (allocated/reserved/consumed/available) + the full
// per-lot ledger (each lot's quota position and 40% reserve incl. released). BRD §11.
import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { dtWallet, trafficWallet, bankerLedger } from "@/lib/dt";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ bankerId: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "FINANCE", "RISK"]);
  if ("response" in g) return g.response;
  const { bankerId } = await params;
  const [lots, traffic, ledger] = await Promise.all([dtWallet(bankerId), trafficWallet(bankerId), bankerLedger(bankerId)]);
  return NextResponse.json({ banker_id: bankerId, lots, traffic, ledger });
}
