// GET /api/live-activations?status=REQUESTED — the Super Admin queue of "Activate live mode"
// requests. `status` defaults to REQUESTED; `status=ALL` lists every banker with a record.
// Decisions are made on the banker's page via /api/merchants/[id]/live-activation.

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { listActivations, ACTIVATION_STATUSES, type ActivationStatus } from "@/lib/live-activation";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const raw = (new URL(req.url).searchParams.get("status") ?? "REQUESTED").toUpperCase();
  const status = raw === "ALL" ? null : (raw as ActivationStatus);
  if (status && !ACTIVATION_STATUSES.includes(status))
    return NextResponse.json({ error: `status must be one of ${ACTIVATION_STATUSES.join(", ")} or ALL` }, { status: 400 });
  try {
    const activations = await listActivations(status);
    const pending = status === "REQUESTED" ? activations.length : (await listActivations("REQUESTED")).length;
    return NextResponse.json({ activations, pending });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
