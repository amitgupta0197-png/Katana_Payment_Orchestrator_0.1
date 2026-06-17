// POST /api/commands/run — execute a slash command (BRD §14 P10).

import { NextResponse } from "next/server";
import { z } from "zod";
import { gateOrResponse } from "@/lib/scope";
import { runCommand } from "@/lib/ai-commands";
import { publish } from "@/lib/events";

export const dynamic = "force-dynamic";
const schema = z.object({ input: z.string().min(1) });

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  const result = await runCommand(body.input);
  await publish({
    eventType: "risk.alert", producer: "admin_console",
    entityType: "command", entityId: result.command, actorId: s.user_id,
    payload: { input: body.input, command: result.command, arg: result.arg },
  });
  return NextResponse.json(result);
}
