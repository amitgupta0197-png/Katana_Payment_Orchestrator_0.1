// GET /api/admin/agents — 9-agent catalog (BRD §14 P10).

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  try {
    const agents = await rows<any>("checkout", `
      SELECT agent_id::text, code, display_name, purpose, commands, enabled,
             last_signal_at, created_at
        FROM ai_agents ORDER BY code
    `).catch(() => []);
    return NextResponse.json({ agents });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
