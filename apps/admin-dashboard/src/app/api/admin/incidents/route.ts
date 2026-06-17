// GET  /api/admin/incidents — list (optional status, severity filter)
// POST /api/admin/incidents — open manual incident

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { listIncidents, openIncidentIfMissing } from "@/lib/incidents";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const url = new URL(req.url);
  try {
    const incidents = await listIncidents({
      status: url.searchParams.get("status") ?? undefined,
      severity: url.searchParams.get("severity") ?? undefined,
    });
    return NextResponse.json({ incidents });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const schema = z.object({
  severity: z.enum(["SEV1","SEV2","SEV3","SEV4"]).default("SEV3"),
  title:    z.string().min(1),
  summary:  z.string().optional(),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const r = await openIncidentIfMissing({
      severity: body.severity, source: "manual",
      title: body.title, summary: body.summary, openedBy: s.email,
    });
    return NextResponse.json(r);
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
