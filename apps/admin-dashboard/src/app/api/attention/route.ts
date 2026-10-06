// "Needs attention" (lib/attention). STAFF ONLY: rows can name a gateway.
//   GET  /api/attention[?fresh=1]                      the ranked list, counts per category
//   POST /api/attention { key, hours?, note? }         hide a row for `hours` (default 24; 0 = show again)
// Reading: SUPER_ADMIN, ADMIN, OPERATOR, SUPPORT. Snoozing: the same.

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { attention, snoozeAttention } from "@/lib/attention-store";
import type { Persona } from "@/lib/auth";

export const dynamic = "force-dynamic";

const READERS: Persona[] = ["SUPER_ADMIN", "ADMIN", "OPERATOR", "SUPPORT"];

export async function GET(req: Request) {
  const g = await gateOrResponse(READERS);
  if ("response" in g) return g.response;
  try {
    return NextResponse.json(await attention(new URL(req.url).searchParams.get("fresh") === "1"));
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const schema = z.object({
  key: z.string().min(3).max(300),
  hours: z.number().int().min(0).max(720).default(24),
  note: z.string().trim().max(300).optional(),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(READERS);
  if ("response" in g) return g.response;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    await snoozeAttention(body.key, g.session.email, body.hours, body.note ?? null);
    return NextResponse.json(await attention());
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
