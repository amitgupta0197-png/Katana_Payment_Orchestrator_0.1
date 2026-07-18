// POST /api/me/logout-all — invalidate every session for the current user across all
// devices (audit M6), then clear this device's cookie. Useful after a suspected token
// compromise. Any other active session stops working on its next request.

import { NextResponse } from "next/server";
import { getSession, clearSessionCookie } from "@/lib/auth";
import { revokeSessions } from "@/lib/session-security";

export const dynamic = "force-dynamic";

export async function POST() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await revokeSessions(session.email);
  await clearSessionCookie();
  return NextResponse.json({ ok: true });
}
