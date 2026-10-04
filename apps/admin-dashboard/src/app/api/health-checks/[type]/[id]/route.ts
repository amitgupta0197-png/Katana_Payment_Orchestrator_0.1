// GET /api/health-checks/{type}/{id} — one actor's health computed now (and cached), with the
// record of what was completed and when (health_checklist_completions). Staff only.

import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { pgError } from "@/lib/pg";
import { completions, computeActor } from "@/lib/health-store";
import { isActorType } from "@/lib/health";
import { HEALTH_READ } from "@/lib/health-access";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ type: string; id: string }> }) {
  const g = await gateOrResponse(HEALTH_READ);
  if ("response" in g) return g.response;
  const p = await params;
  const type = p.type.toUpperCase();
  const id = decodeURIComponent(p.id);
  if (!isActorType(type)) return NextResponse.json({ error: "unknown actor type" }, { status: 400 });
  try {
    const health = await computeActor(type, id);
    if (!health) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ health, completions: await completions(type, id), computed_at: new Date().toISOString() });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
