// POST /api/support-bot/feedback { message_id, rating: 1 | -1 | null, note? }: someone rates
// one support bot answer: staff on any, a merchant or banker on answers in its own
// conversations. Rated answers, with the note saying what the right answer was, become the
// bot's test set (lib/support-bot).

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { answerConversation, getConversation, setFeedback } from "@/lib/support-bot/store";
import { botUser, canRead } from "@/lib/support-bot/access";

export const dynamic = "force-dynamic";

const schema = z.object({
  message_id: z.string().regex(/^\d+$/),
  rating: z.union([z.literal(1), z.literal(-1), z.null()]),
  note: z.string().max(2000).optional(),
});

export async function POST(req: Request) {
  const a = await botUser();
  if ("response" in a) return a.response;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const c = await answerConversation(body.message_id);
    if (!c || !canRead(a.user, await getConversation(c))) return NextResponse.json({ error: "answer not found" }, { status: 404 });
    const ok = await setFeedback(body.message_id, body.rating, body.note ?? null, a.user.session.email);
    if (!ok) return NextResponse.json({ error: "answer not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
