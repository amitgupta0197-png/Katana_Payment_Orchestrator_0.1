// GET /api/providers/code?name=…&code=… — the create journey's merchant code.
//   suggestion  a code built from the name that no merchant has yet
//   available   whether `code` is still free (case does not matter)
// SUPER_ADMIN only, like creating a merchant.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { codeFromName, nextFreeCode } from "@/lib/merchant-code";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const q = new URL(req.url).searchParams;
  const base = codeFromName(q.get("name") ?? "");
  const code = (q.get("code") ?? "").trim();
  try {
    const taken = await rows<{ code: string }>("provider", `
      SELECT code FROM providers WHERE tenant_id = 'tenant-default' AND (upper(code) = upper($1) OR upper(code) LIKE upper($2) || '%')
    `, [code, base || "\u0000"]);
    return NextResponse.json({
      suggestion: base ? nextFreeCode(base, taken.map((t) => t.code)) : null,
      available: code ? !taken.some((t) => t.code.toUpperCase() === code.toUpperCase()) : null,
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
