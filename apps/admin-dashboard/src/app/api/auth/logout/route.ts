import { NextResponse } from "next/server";
import { clearSessionCookie, getSession } from "@/lib/auth";
import { publish } from "@/lib/events";
import { revokeSession, revokeSessions } from "@/lib/session-security";

export async function POST() {
  const s = await getSession();
  await clearSessionCookie();
  if (s) {
    // Clearing the cookie only clears this browser's copy. Revoking the session is what makes
    // a copy taken earlier useless. A session from before sessions had an id can only be ended
    // with the user's others.
    if (s.sid) await revokeSession(s.sid, s.email, s.exp);
    else await revokeSessions(s.email);
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
