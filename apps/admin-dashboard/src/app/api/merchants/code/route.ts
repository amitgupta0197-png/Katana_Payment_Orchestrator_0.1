// GET /api/merchants/code?name=…&code=… — a banker code for the onboarding wizard
// (lib/banker-wizard): built from the name, and whether a given code is already a banker's.
// Super Admin only (banker creation is). Read-only.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { codeFromName, nextFreeCode } from "@/lib/merchant-code";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const u = new URL(req.url);
  const name = (u.searchParams.get("name") ?? "").trim();
  const code = (u.searchParams.get("code") ?? "").trim().toUpperCase();
  const base = code || codeFromName(name);
  if (!base) return NextResponse.json({ code: "", taken: false, free: null });
  try {
    // Every banker code that starts like this one, so the free one is found in a single read.
    const like = await rows<{ c: string }>("merchant",
      `SELECT upper(merchant_code) AS c FROM merchants WHERE upper(merchant_code) LIKE $1 || '%'`, [base]);
    const taken = like.some((r) => r.c === base);
    return NextResponse.json({ code: base, taken, free: taken ? nextFreeCode(base, like.map((r) => r.c)) : base });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
