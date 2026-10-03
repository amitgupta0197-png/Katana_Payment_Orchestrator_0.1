// GET /api/support-bot/attachments/{id}: a screenshot attached to a support bot question, for
// whoever may read its conversation (lib/support-bot/access).

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { getAttachment, getConversation } from "@/lib/support-bot/store";
import { botUser, canRead } from "@/lib/support-bot/access";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const a = await botUser();
  if ("response" in a) return a.response;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const att = await getAttachment(id);
    if (!att || !canRead(a.user, await getConversation(att.conversation_id))) return NextResponse.json({ error: "not found" }, { status: 404 });
    return new Response(new Uint8Array(att.data), {
      headers: {
        "Content-Type": att.media_type, "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'",
      },
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
