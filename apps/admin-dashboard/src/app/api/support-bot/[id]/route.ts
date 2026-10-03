// GET /api/support-bot/{conversation id}: the questions and answers of one support bot
// conversation. Staff also get what the bot looked up for each answer; a merchant or banker
// reads only its own portal conversations (lib/support-bot/access).

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { getConversation, shownMessages } from "@/lib/support-bot/store";
import { botUser, canRead } from "@/lib/support-bot/access";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const a = await botUser();
  if ("response" in a) return a.response;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const c = await getConversation(id);
    if (!canRead(a.user, c)) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ conversation: c, messages: await shownMessages(id, a.user.staff) });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
