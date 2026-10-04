// /api/banks — the bank master (merchant 0018, lib/chain-store). Staff only.
//   GET   every bank, with how many TSPs it confirmed and bankers it issued for
//   POST  { code, name, bank_type, settlement_account?, neft_enabled?, imps_enabled?, upi_enabled?, contact_email? }

import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { CHAIN_READ, CHAIN_WRITE, createBank, listBanks } from "@/lib/chain-store";
import { chainErrorResponse, jsonBody } from "@/lib/chain-http";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(CHAIN_READ);
  if ("response" in g) return g.response;
  try { return NextResponse.json({ banks: await listBanks() }); } catch (e) { return chainErrorResponse(e); }
}

export async function POST(req: Request) {
  const g = await gateOrResponse(CHAIN_WRITE);
  if ("response" in g) return g.response;
  const b = await jsonBody(req);
  if (!b) return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  try {
    const r = await createBank({ ...b, code: typeof b.code === "string" ? b.code.trim().toUpperCase() : b.code }, { id: g.session.user_id, email: g.session.email });
    return NextResponse.json(r, { status: 201 });
  } catch (e) { return chainErrorResponse(e); }
}
