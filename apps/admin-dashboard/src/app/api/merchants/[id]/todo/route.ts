// GET /api/merchants/[id]/todo — the banker page's "What's left" (lib/banker-todo): five steps to
// taking live money, ticked from real state, and the live orders refused today in plain words
// (lib/plain-errors). Staff only (it names the gateway): SUPER_ADMIN, ADMIN, OPERATOR, SUPPORT.

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { bankerTodoFacts, refusedOrdersToday } from "@/lib/banker-check-store";
import { bankerTodo } from "@/lib/banker-todo";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "OPERATOR", "SUPPORT"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  try {
    const f = await bankerTodoFacts(id);
    if (!f) return NextResponse.json({ error: "banker not found" }, { status: 404 });
    return NextResponse.json({ ...bankerTodo(f), refused: await refusedOrdersToday(f.check.code) });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
