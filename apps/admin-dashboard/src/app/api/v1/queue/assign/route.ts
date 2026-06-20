// POST /api/v1/queue/assign — operator claims the head of the FIFO queue (BRD §19,
// §15 steps 7-9). The operator record is auto-resolved from the session.

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { operatorForUser, assignNextForOperator } from "@/lib/fifo";

export const dynamic = "force-dynamic";

export async function POST(_req: Request) {
  const g = await gateOrResponse(["OPERATOR", "SUPER_ADMIN", "ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;

  try {
    const opId = await operatorForUser(s.email, s.full_name, s.user_id);
    if (!opId) return NextResponse.json({ error: "could not resolve operator" }, { status: 500 });
    const r = await assignNextForOperator(opId);
    if (r.error) return NextResponse.json({ error: r.error }, { status: r.status ?? 400 });
    return NextResponse.json({ assigned: r.assigned });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
