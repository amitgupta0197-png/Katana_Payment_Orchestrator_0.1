// POST /api/v1/mfa/enroll — start MFA enrolment for the caller; returns the
// otpauth URI + secret to add to an authenticator (BRD SEC-003).

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { enrollMfa } from "@/lib/fifo-mfa";

export const dynamic = "force-dynamic";
const ALL = ["SUPER_ADMIN", "ADMIN", "PROVIDER", "MERCHANT", "OPERATOR", "COMPLIANCE", "FINANCE", "RISK", "SUPPORT"] as const;

export async function POST() {
  const g = await gateOrResponse([...ALL]);
  if ("response" in g) return g.response;
  try {
    const r = await enrollMfa(g.session.email, g.session.user_id);
    return NextResponse.json({ ok: true, ...r });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
