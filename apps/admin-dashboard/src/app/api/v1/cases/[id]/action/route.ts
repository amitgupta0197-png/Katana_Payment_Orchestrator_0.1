// POST /api/v1/cases/[id]/action — add a note/evidence, place the linked order on
// HOLD, or close the case (BRD §23).

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { addNote, placeCaseHold, closeCase } from "@/lib/fifo-cases";

export const dynamic = "force-dynamic";

const schema = z.object({
  action: z.enum(["note", "evidence", "hold", "close"]),
  body: z.string().optional(),
  evidence_ref: z.string().optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "COMPLIANCE", "RISK"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  let b;
  try { b = schema.parse(await req.json()); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }

  try {
    const c = (await rows<{ id: string }>("fifo", `SELECT id::text FROM fifo_cases WHERE id::text=$1 OR case_ref=$1 LIMIT 1`, [id]))[0];
    if (!c) return NextResponse.json({ error: "case not found" }, { status: 404 });
    const actor = g.session.email;

    if (b.action === "note" || b.action === "evidence") {
      await addNote({ caseId: c.id, kind: b.action === "evidence" ? "EVIDENCE" : "NOTE", body: b.body, evidenceRef: b.evidence_ref, author: actor });
      return NextResponse.json({ ok: true });
    }
    if (b.action === "hold") {
      const r = await placeCaseHold(c.id, actor);
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 409 });
      return NextResponse.json({ ok: true, status: "HOLD" });
    }
    await closeCase(c.id, actor);
    return NextResponse.json({ ok: true, status: "CLOSED" });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
