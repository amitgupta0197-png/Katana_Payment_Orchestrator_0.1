// POST /api/admin/contract-tests — run all adapter contract tests.
import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { runAllContracts } from "@/lib/contract-tests";

export const dynamic = "force-dynamic";

export async function POST() {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const r = await runAllContracts();
  return NextResponse.json(r);
}
