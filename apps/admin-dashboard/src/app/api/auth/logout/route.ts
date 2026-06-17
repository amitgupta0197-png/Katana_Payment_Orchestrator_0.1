import { NextResponse } from "next/server";
import { clearSessionCookie, getSession } from "@/lib/auth";
import { publish } from "@/lib/events";

export async function POST() {
  const s = await getSession();
  await clearSessionCookie();
  if (s) {
    await publish({
      eventType: "auth.session_ended",
      producer: "auth",
      entityType: "session",
      entityId: s.user_id,
      actorId: s.user_id,
      payload: { email: s.email, persona: s.persona },
    });
  }
  return NextResponse.json({ ok: true });
}
