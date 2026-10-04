// GET /api/nav/features — what the staff menu needs: the nav feature flags (lib/features) and
// the caller's own Access Matrix read rights (lib/access rightsFor), so lib/nav personaNav can
// hide a section or an entry. Staff sessions only. Flags hide menu entries only: every page
// stays reachable by its URL whatever they say.

import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { rightsFor } from "@/lib/access";
import { serverFeatures } from "@/lib/features";
import type { NavAccess } from "@/lib/nav";

export const dynamic = "force-dynamic";

const STAFF = ["SUPER_ADMIN", "ADMIN", "OPERATOR", "COMPLIANCE", "FINANCE", "RISK", "SUPPORT"] as const;

export async function GET() {
  // MFA is not required: the menu is drawn on /security too, and this says nothing secret.
  const g = await gateOrResponse([...STAFF], { requireMfa: false });
  if ("response" in g) return g.response;
  const persona = g.session.persona;
  const access: NavAccess = {};
  if (persona !== "SUPER_ADMIN") {
    const rights = await rightsFor(persona).catch(() => ({}));
    for (const [code, r] of Object.entries(rights)) access[code] = { can_read: r.can_read };
  }
  return NextResponse.json({ persona, features: serverFeatures(), access });
}
