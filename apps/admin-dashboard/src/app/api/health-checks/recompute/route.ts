// POST /api/health-checks/recompute — { type, id } recomputes one actor; {} recomputes every actor
// (what the cron does, without its alerts). SUPER_ADMIN / ADMIN.

import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { pgError } from "@/lib/pg";
import { computeActor, computeAll } from "@/lib/health-store";
import { isActorType } from "@/lib/health";
import { HEALTH_WRITE } from "@/lib/health-access";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const g = await gateOrResponse(HEALTH_WRITE);
  if ("response" in g) return g.response;
  const body = (await req.json().catch(() => ({}))) as { type?: string; id?: string };
  try {
    if (body.type || body.id) {
      const type = String(body.type ?? "").toUpperCase();
      if (!isActorType(type) || !body.id) return NextResponse.json({ error: "give both type and id, or neither" }, { status: 400 });
      const health = await computeActor(type, String(body.id));
      if (!health) return NextResponse.json({ error: "not found" }, { status: 404 });
      return NextResponse.json({ ok: true, health });
    }
    const all = await computeAll();
    return NextResponse.json({ ok: true, counts: all.counts });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
