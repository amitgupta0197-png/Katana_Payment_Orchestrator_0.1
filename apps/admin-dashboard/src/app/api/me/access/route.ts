// Caller's own per-module rights. Cached client-side by useAccess() so list
// pages can gate CTAs without an extra round-trip per check.

import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { rightsFor } from "@/lib/access";
import { pgError } from "@/lib/pg";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  try {
    const rights = await rightsFor(g.session.persona);
    return NextResponse.json({ persona: g.session.persona, rights });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
