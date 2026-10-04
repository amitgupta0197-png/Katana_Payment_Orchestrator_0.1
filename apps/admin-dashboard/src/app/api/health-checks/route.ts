// GET /api/health-checks?type=BANKER&ids=a,b[&bands=RED,BLOCKED][&live=1]
// Cached health rows (actor_health, lib/health-store) for a list page or the console. Lists read
// the cache as it is (the cron refreshes it every 5 minutes); one id alone is recomputed when stale.
// Staff only: items may name a TSP or a gateway.

import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { pgError } from "@/lib/pg";
import { readCached } from "@/lib/health-store";
import { BANDS, isActorType, type Band } from "@/lib/health";
import { HEALTH_READ } from "@/lib/health-access";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(HEALTH_READ);
  if ("response" in g) return g.response;
  const sp = new URL(req.url).searchParams;
  const type = (sp.get("type") ?? "").toUpperCase();
  if (!isActorType(type)) return NextResponse.json({ error: "type must be TSP, BANKER, MERCHANT or INTEGRATION" }, { status: 400 });
  const ids = (sp.get("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 1000);
  const bands = (sp.get("bands") ?? "").split(",").map((s) => s.trim().toUpperCase()).filter((b): b is Band => (BANDS as string[]).includes(b));
  const limit = Math.max(1, Math.min(Number(sp.get("limit") ?? 5000) || 5000, 5000));
  try {
    const list = await readCached(type, ids.length ? ids : null, { bands, liveOnly: sp.get("live") === "1", limit });
    return NextResponse.json({ type, rows: list });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
