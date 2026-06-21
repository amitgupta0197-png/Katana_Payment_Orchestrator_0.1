// GET /api/v1/mfa/status — the caller's own MFA + trusted devices (BRD SEC-003/004).

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { getMfa, isSensitiveRole, MFA_ENFORCED } from "@/lib/fifo-mfa";

export const dynamic = "force-dynamic";
const ALL = ["SUPER_ADMIN", "ADMIN", "PROVIDER", "MERCHANT", "OPERATOR", "COMPLIANCE", "FINANCE", "RISK", "SUPPORT"] as const;

export async function GET() {
  const g = await gateOrResponse([...ALL]);
  if ("response" in g) return g.response;
  const s = g.session;
  try {
    const mfa = await getMfa(s.email);
    const devices = await rows<any>("fifo", `
      SELECT device_hash, label, trusted, first_seen, last_seen FROM fifo_user_devices WHERE email=$1 ORDER BY last_seen DESC LIMIT 20
    `, [s.email]).catch(() => []);
    return NextResponse.json({
      email: s.email, enabled: !!mfa?.enabled, enforced: MFA_ENFORCED,
      sensitive_role: isSensitiveRole(s.persona), current_device: s.device ?? null, devices,
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
