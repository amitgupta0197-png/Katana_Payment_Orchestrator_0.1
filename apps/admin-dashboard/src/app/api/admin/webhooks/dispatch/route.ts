// POST /api/admin/webhooks/dispatch — manually drain N due outbox rows.
// Sprint 9 will move this to a queue worker.

import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { dispatchPending } from "@/lib/webhook-outbox";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 25), 100);
  const result = await dispatchPending({ limit });
  return NextResponse.json(result);
}
