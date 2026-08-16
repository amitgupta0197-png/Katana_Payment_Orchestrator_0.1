// GET /api/banker-portal/statement — downloadable transaction statement for one banker.
//
// Same parameters as the provider endpoint. MERCHANT only (middleware restricts
// /api/banker-portal/* to that persona); the MERCHANT session's scope_id IS the
// merchant_code every downstream table keys on, so the scope is that single code.

import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { statementResponse } from "@/lib/statement-route";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["MERCHANT"]);
  if ("response" in g) return g.response;

  const code = g.session.scope_id;
  if (!code) return NextResponse.json({ error: "MERCHANT session missing scope_id" }, { status: 400 });
  return statementResponse(req, [code]);
}
