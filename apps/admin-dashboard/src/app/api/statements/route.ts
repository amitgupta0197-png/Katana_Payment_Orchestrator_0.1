// GET /api/statements — downloadable transaction statement, tenant-wide.
//
// Same parameters as the two portal endpoints, plus optional ?codes=A,B to narrow the
// statement to specific banker codes.
//
// This path sits outside the persona-exclusive /api/{merchant,banker}-portal prefixes, so
// the middleware applies no persona rule to it and the gate below is the only thing
// standing between a session and an unscoped read. Keep the persona list tight.

import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { statementResponse } from "@/lib/statement-route";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "FINANCE"]);
  if ("response" in g) return g.response;

  const raw = new URL(req.url).searchParams.get("codes");
  const codes = raw
    ? raw.split(",").map((c) => c.trim()).filter(Boolean)
    : null;
  // An explicit but empty ?codes= is a filter that selects nothing — honour it as such
  // instead of silently widening to every banker.
  return statementResponse(req, raw !== null ? (codes ?? []) : null);
}
