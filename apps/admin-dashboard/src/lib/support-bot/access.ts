// Who may use the support bot, and on which conversations (lib/support-bot). One set of routes
// (/api/support-bot/*) serves staff testing it and merchants and bankers using it.
//
//   staff (Super Admin, Admin, Support)  any scope they choose; every conversation, both channels
//   merchant (PROVIDER) / banker (MERCHANT)  their own scope only, PORTAL conversations only,
//                                         and only once SUPPORT_BOT_PORTALS is on
//
// A conversation someone may not read is answered "not found": whether it exists is information.

import { NextResponse } from "next/server";
import { rows } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import type { Session } from "@/lib/auth";
import { BOT_PORTAL_PERSONAS, BOT_STAFF_PERSONAS, portalsEnabled, sessionScopeKey, type ScopeKey } from "@/lib/support-bot/scope";
import type { ConversationRow } from "@/lib/support-bot/store";

export type BotUser =
  | { staff: true; session: Session }
  | { staff: false; session: Session; scopeKey: ScopeKey };

/** The signed-in user, or the response refusing them. */
export async function botUser(): Promise<{ user: BotUser } | { response: NextResponse }> {
  const g = await gateOrResponse([...BOT_STAFF_PERSONAS, ...BOT_PORTAL_PERSONAS]);
  if ("response" in g) return g;
  if ((BOT_STAFF_PERSONAS as readonly string[]).includes(g.session.persona)) return { user: { staff: true, session: g.session } };
  if (!portalsEnabled())
    return { response: NextResponse.json({ error: "The support assistant is not available yet.", code: "NOT_ENABLED" }, { status: 403 }) };
  const scopeKey = await sessionScopeKey(g.session);
  if (!scopeKey) return { response: NextResponse.json({ error: "No account is linked to this login.", code: "NO_ACCOUNT" }, { status: 403 }) };
  return { user: { staff: false, session: g.session, scopeKey } };
}

export function canRead(u: BotUser, c: ConversationRow | null): c is ConversationRow {
  if (!c) return false;
  return u.staff || (c.channel === "PORTAL" && c.scope_key === u.scopeKey);
}

/** Questions a merchant or banker may ask in a day (India time), across its conversations. */
export function dailyLimit(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.SUPPORT_BOT_DAILY_LIMIT);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 100;
}

export async function questionsToday(scopeKey: ScopeKey): Promise<number> {
  const r = await rows<{ n: number }>("merchant", `
    SELECT COUNT(*)::int AS n FROM support_bot_messages m JOIN support_bot_conversations c ON c.id = m.conversation_id
     WHERE c.scope_key = $1 AND c.channel = 'PORTAL' AND m.role = 'user' AND m.display IS NOT NULL
       AND m.created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')
  `, [scopeKey]);
  return r[0]?.n ?? 0;
}
