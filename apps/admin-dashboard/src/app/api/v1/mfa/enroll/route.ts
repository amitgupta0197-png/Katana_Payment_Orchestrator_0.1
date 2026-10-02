// POST /api/v1/mfa/enroll — start MFA enrolment for the caller; returns the
// otpauth URI + secret to add to an authenticator (BRD SEC-003).

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { enrollMfa, MfaCodeRequired } from "@/lib/fifo-mfa";

export const dynamic = "force-dynamic";
const ALL = ["SUPER_ADMIN", "ADMIN", "PROVIDER", "MERCHANT", "OPERATOR", "COMPLIANCE", "FINANCE", "RISK", "SUPPORT"] as const;

// Body (only when two-factor is already on): { token } — a current code, to replace the secret.
export async function POST(req: Request) {
  const g = await gateOrResponse([...ALL], { requireMfa: false });
  if ("response" in g) return g.response;
  const body = await req.json().catch(() => ({})) as { token?: unknown };
  try {
    const r = await enrollMfa(g.session.email, g.session.user_id, typeof body.token === "string" ? body.token : null);
    return NextResponse.json({ ok: true, ...r });
  } catch (err) {
    if (err instanceof MfaCodeRequired) return NextResponse.json({ error: err.message, code: "MFA_CODE_REQUIRED" }, { status: 400 });
    const e = pgError(err); return NextResponse.json(e.body, { status: e.status });
  }
}
