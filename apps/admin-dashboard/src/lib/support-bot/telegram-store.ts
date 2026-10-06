// Storage for the support bot's Telegram groups (merchant 0023, lib/support-bot/telegram):
// groups and their linked scope, one-time link codes, Katana staff's Telegram users, the inbox
// of messages to answer, and what was done with each.

import { rows } from "@/lib/pg";
import { createConversation } from "@/lib/support-bot/store";
import { envStaffIds, newLinkCode } from "@/lib/support-bot/telegram-rules";
import type { ScopeKey } from "@/lib/support-bot/scope";

export interface TgGroup {
  chat_id: string; title: string | null; username: string | null; scope_key: ScopeKey | null;
  status: "ACTIVE" | "PAUSED"; linked_by: string | null; linked_at: string | null;
  unlinked_notice_at: string | null; conversation_id: string | null; conversation_day: string | null;
}

const GROUP_COLS = `chat_id::text, title, username, scope_key, status, linked_by, linked_at, unlinked_notice_at,
  conversation_id::text, conversation_day::text`;
const IST_TODAY = `(now() AT TIME ZONE 'Asia/Kolkata')::date`;
const IST_DAY_START = `(date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`;

/** The group, created (unlinked) the first time the bot hears from it; title kept fresh. */
export async function touchGroup(chatId: number, title: string | null, username: string | null): Promise<TgGroup> {
  const r = await rows<TgGroup>("merchant", `
    INSERT INTO support_bot_tg_groups (chat_id, title, username) VALUES ($1, $2, $3)
    ON CONFLICT (chat_id) DO UPDATE SET title = COALESCE(EXCLUDED.title, support_bot_tg_groups.title),
      username = EXCLUDED.username, updated_at = now()
    RETURNING ${GROUP_COLS}
  `, [chatId, title, username]);
  return r[0];
}

export async function getGroup(chatId: number | string): Promise<TgGroup | null> {
  return (await rows<TgGroup>("merchant", `SELECT ${GROUP_COLS} FROM support_bot_tg_groups WHERE chat_id = $1::bigint`, [chatId]))[0] ?? null;
}

/** Telegram moved a group to a supergroup: the link moves with it. */
export async function migrateGroup(fromChat: number, toChat: number): Promise<void> {
  await rows("merchant", `
    INSERT INTO support_bot_tg_groups (chat_id, title, username, scope_key, status, linked_by, linked_at, unlinked_notice_at)
    SELECT $2, title, username, scope_key, status, linked_by, linked_at, unlinked_notice_at FROM support_bot_tg_groups WHERE chat_id = $1
    ON CONFLICT (chat_id) DO UPDATE SET scope_key = COALESCE(support_bot_tg_groups.scope_key, EXCLUDED.scope_key),
      linked_by = COALESCE(support_bot_tg_groups.linked_by, EXCLUDED.linked_by),
      linked_at = COALESCE(support_bot_tg_groups.linked_at, EXCLUDED.linked_at), updated_at = now()
  `, [fromChat, toChat]);
  await rows("merchant", `UPDATE support_bot_tg_groups SET scope_key = NULL, status = 'PAUSED', updated_at = now() WHERE chat_id = $1`, [fromChat]);
}

/** Note that an unlinked group was told; true only the first time. */
export async function markUnlinkedNotice(chatId: number): Promise<boolean> {
  const r = await rows("merchant", `
    UPDATE support_bot_tg_groups SET unlinked_notice_at = now() WHERE chat_id = $1 AND unlinked_notice_at IS NULL RETURNING 1
  `, [chatId]);
  return r.length > 0;
}

/** A one-time code to link a group to a scope; valid 24 hours. */
export async function createLinkCode(scopeKey: ScopeKey, by: string): Promise<{ code: string; expires_at: string }> {
  for (let i = 0; i < 5; i++) {
    const code = newLinkCode();
    const r = await rows<{ code: string; expires_at: string }>("merchant", `
      INSERT INTO support_bot_tg_link_codes (code, scope_key, created_by, expires_at) VALUES ($1, $2, $3, now() + interval '24 hours')
      ON CONFLICT (code) DO NOTHING RETURNING code, expires_at
    `, [code, scopeKey, by]);
    if (r[0]) return r[0];
  }
  throw new Error("could not make a link code");
}

/** Use a code: the group is linked to its scope. Null when the code is unknown, used or expired. */
export async function useLinkCode(code: string, chatId: number, by: string): Promise<ScopeKey | null> {
  const r = await rows<{ scope_key: ScopeKey }>("merchant", `
    UPDATE support_bot_tg_link_codes SET used_at = now(), used_chat = $2
     WHERE code = $1 AND used_at IS NULL AND expires_at > now() RETURNING scope_key
  `, [code, chatId]);
  if (!r[0]) return null;
  await rows("merchant", `
    UPDATE support_bot_tg_groups SET scope_key = $2, status = 'ACTIVE', linked_by = $3, linked_at = now(),
      conversation_id = NULL, conversation_day = NULL, updated_at = now() WHERE chat_id = $1
  `, [chatId, r[0].scope_key, by]);
  return r[0].scope_key;
}

export async function unlinkGroup(chatId: number | string, by: string): Promise<boolean> {
  const r = await rows("merchant", `
    UPDATE support_bot_tg_groups SET scope_key = NULL, linked_by = $2, linked_at = NULL, conversation_id = NULL,
      conversation_day = NULL, unlinked_notice_at = now(), updated_at = now() WHERE chat_id = $1::bigint RETURNING 1
  `, [chatId, by]);
  return r.length > 0;
}

export async function setGroupStatus(chatId: number | string, status: "ACTIVE" | "PAUSED"): Promise<boolean> {
  const r = await rows("merchant", `UPDATE support_bot_tg_groups SET status = $2, updated_at = now() WHERE chat_id = $1::bigint RETURNING 1`, [chatId, status]);
  return r.length > 0;
}

/** The group's conversation for today (India time), started when there is none. */
export async function todaysConversation(g: TgGroup, title: string): Promise<string> {
  const today = (await rows<{ d: string }>("merchant", `SELECT ${IST_TODAY}::text AS d`))[0].d;
  if (g.conversation_id && g.conversation_day === today) return g.conversation_id;
  const id = await createConversation(g.scope_key!, "TELEGRAM", title || g.title || "Telegram", `telegram:${g.chat_id}`);
  await rows("merchant", `UPDATE support_bot_tg_groups SET conversation_id = $2::uuid, conversation_day = $3::date WHERE chat_id = $1::bigint`,
    [g.chat_id, id, today]);
  return id;
}

// ── Staff ─────────────────────────────────────────────────────────────────────────────────

export async function staffIds(): Promise<Set<number>> {
  const r = await rows<{ user_id: string }>("merchant", `SELECT user_id::text FROM support_bot_tg_staff`).catch(() => []);
  return new Set([...r.map((x) => Number(x.user_id)), ...envStaffIds()]);
}
export async function listStaff(): Promise<{ user_id: string; name: string | null; added_by: string; added_at: string }[]> {
  return rows("merchant", `SELECT user_id::text, name, added_by, added_at FROM support_bot_tg_staff ORDER BY added_at`);
}
export async function addStaff(userId: number, name: string | null, by: string): Promise<void> {
  await rows("merchant", `
    INSERT INTO support_bot_tg_staff (user_id, name, added_by) VALUES ($1, $2, $3)
    ON CONFLICT (user_id) DO UPDATE SET name = COALESCE(EXCLUDED.name, support_bot_tg_staff.name)
  `, [userId, name, by]);
}
export async function removeStaff(userId: number): Promise<void> {
  await rows("merchant", `DELETE FROM support_bot_tg_staff WHERE user_id = $1`, [userId]);
}

// ── Updates, inbox, answers ───────────────────────────────────────────────────────────────

/** True the first time an update id is seen. */
export async function firstSeen(updateId: number): Promise<boolean> {
  const r = await rows("merchant", `INSERT INTO support_bot_tg_updates (update_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING 1`, [updateId]);
  return r.length > 0;
}

export interface InboxRow { id: string; chat_id: string; message_id: string; user_id: string | null; user_name: string | null; text: string | null; photo_file: string | null }

export async function addToInbox(m: { chatId: number; messageId: number; userId: number | null; userName: string | null; text: string; photoFile: string | null }): Promise<string | null> {
  const r = await rows<{ id: string }>("merchant", `
    INSERT INTO support_bot_tg_inbox (chat_id, message_id, user_id, user_name, text, photo_file)
    VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (chat_id, message_id) DO NOTHING RETURNING id::text
  `, [m.chatId, m.messageId, m.userId, m.userName, m.text || null, m.photoFile]);
  return r[0]?.id ?? null;
}

/**
 * Claim every unanswered message of the group, but only for the newest one's handler: an older
 * message's handler, woken after the burst, finds a newer one and leaves them to it.
 */
export async function claimBurst(chatId: number, myId: string): Promise<InboxRow[]> {
  const newest = (await rows<{ id: string }>("merchant", `
    SELECT MAX(id)::text AS id FROM support_bot_tg_inbox WHERE chat_id = $1 AND handled_at IS NULL
  `, [chatId]))[0]?.id;
  if (newest !== myId) return [];
  return rows<InboxRow>("merchant", `
    UPDATE support_bot_tg_inbox SET handled_at = now() WHERE chat_id = $1 AND handled_at IS NULL AND id <= $2::bigint
    RETURNING id::text, chat_id::text, message_id::text, user_id::text, user_name, text, photo_file
  `, [chatId, myId]).then((r) => r.sort((a, b) => Number(a.id) - Number(b.id)));
}

export type Outcome = "ANSWERED" | "ESCALATED" | "SILENT" | "LIMIT" | "ERROR";

export async function logAnswer(a: {
  chatId: number; messageId: number | null; scopeKey: string | null; outcome: Outcome; reason?: string | null;
  question: string; reply?: string | null; conversationId?: string | null; model?: string | null; cost?: number | null;
}): Promise<void> {
  await rows("merchant", `
    INSERT INTO support_bot_tg_answers (chat_id, message_id, scope_key, outcome, reason, question, reply, conversation_id, model, cost_usd)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid, $9, $10)
  `, [a.chatId, a.messageId, a.scopeKey, a.outcome, a.reason ?? null, a.question.slice(0, 4000), a.reply?.slice(0, 4000) ?? null,
      a.conversationId ?? null, a.model ?? null, a.cost ?? null]).catch((e) => console.error(`[support-bot:telegram] log: ${(e as Error).message}`));
}

/** Questions the model was asked for this group today (India time). */
export async function answersToday(chatId: number): Promise<number> {
  const r = await rows<{ n: number }>("merchant", `
    SELECT COUNT(*)::int AS n FROM support_bot_tg_answers
     WHERE chat_id = $1 AND outcome IN ('ANSWERED', 'SILENT', 'ESCALATED') AND (reason IS NULL OR reason NOT LIKE 'RULE%') AND created_at >= ${IST_DAY_START}
  `, [chatId]);
  return r[0]?.n ?? 0;
}

/** Whether the bot answered the limit notice in this group today already. */
export async function limitNoticeToday(chatId: number): Promise<boolean> {
  const r = await rows("merchant", `SELECT 1 FROM support_bot_tg_answers WHERE chat_id = $1 AND outcome = 'LIMIT' AND created_at >= ${IST_DAY_START} LIMIT 1`, [chatId]);
  return r.length > 0;
}

// ── Settings ──────────────────────────────────────────────────────────────────────────────

export async function pausedAll(): Promise<boolean> {
  const r = await rows<{ value: string }>("merchant", `SELECT value FROM support_bot_tg_settings WHERE key = 'paused_all'`).catch(() => []);
  return r[0]?.value === "1";
}
export async function setPausedAll(paused: boolean, by: string): Promise<void> {
  await rows("merchant", `
    INSERT INTO support_bot_tg_settings (key, value, updated_by) VALUES ('paused_all', $1, $2)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
  `, [paused ? "1" : "0", by]);
}

// ── Staff page ────────────────────────────────────────────────────────────────────────────

export interface GroupView extends TgGroup { today: number; last_answer_at: string | null }

export async function listGroups(): Promise<GroupView[]> {
  return rows<GroupView>("merchant", `
    SELECT ${GROUP_COLS.split(",").map((c) => `g.${c.trim()}`).join(", ")},
      (SELECT COUNT(*)::int FROM support_bot_tg_answers a WHERE a.chat_id = g.chat_id AND a.created_at >= ${IST_DAY_START}) AS today,
      (SELECT MAX(a.created_at) FROM support_bot_tg_answers a WHERE a.chat_id = g.chat_id) AS last_answer_at
      FROM support_bot_tg_groups g ORDER BY g.updated_at DESC LIMIT 500
  `);
}

export async function recentAnswers(limit = 50): Promise<{
  id: string; chat_id: string; title: string | null; outcome: Outcome; reason: string | null; question: string | null;
  reply: string | null; conversation_id: string | null; model: string | null; created_at: string;
}[]> {
  return rows("merchant", `
    SELECT a.id::text, a.chat_id::text, g.title, a.outcome, a.reason, a.question, a.reply, a.conversation_id::text, a.model, a.created_at
      FROM support_bot_tg_answers a LEFT JOIN support_bot_tg_groups g ON g.chat_id = a.chat_id
     ORDER BY a.created_at DESC LIMIT ${Math.min(limit, 200)}
  `);
}
