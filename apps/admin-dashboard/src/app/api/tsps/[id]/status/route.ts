// PATCH /api/tsps/{id}/status — move a TSP through onboarding and its life.
//   { action: "advance", notes?, override? }  the next step. At SCREENING it runs the sanctions /
//        PEP check (a hit refuses; a Super Admin may override with a note). From CONFIG it raises
//        `tsp.go_live` for a second person.
//   { action: "suspend" | "reactivate", notes }  through Maker-Checker
//   { action: "reject", notes }  a TSP not yet live, at once
// Screening may be run by Compliance; everything else by Super Admin / Admin.

import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { advanceTsp, CHAIN_REVIEW, CHAIN_WRITE, getTsp, tspStatusChange } from "@/lib/chain-store";
import { chainErrorResponse, jsonBody, UUID_RE } from "@/lib/chain-http";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(CHAIN_REVIEW);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "TSP not found" }, { status: 404 });
  const b = await jsonBody(req);
  const action = b?.action;
  if (!["advance", "suspend", "reactivate", "reject"].includes(action))
    return NextResponse.json({ error: "action must be advance, suspend, reactivate or reject" }, { status: 400 });
  const notes = typeof b?.notes === "string" ? b.notes : "";
  try {
    const t = await getTsp(id);
    if (!t) return NextResponse.json({ error: "TSP not found" }, { status: 404 });
    // Compliance may screen; every other move is Super Admin / Admin.
    const screening = action === "advance" && t.stage === "SCREENING";
    if (!screening && !(CHAIN_WRITE as string[]).includes(s.persona))
      return NextResponse.json({ error: "Super Admin or Admin only" }, { status: 403 });
    const by = { id: s.user_id, email: s.email, persona: s.persona };
    const r = action === "advance"
      ? await advanceTsp(id, by, { notes, override: b?.override === true })
      : await tspStatusChange(id, action, by, notes);
    return NextResponse.json({ ok: true, ...r });
  } catch (e) { return chainErrorResponse(e); }
}
