// Support bot conversations (merchant 0016, 0017): saved so a conversation can be continued
// where it stopped, and so staff can review answers and rate them. Each message is kept as the
// model saw it, except that an attached screenshot is kept in support_bot_attachments and the
// message holds a reference to it, filled back in by loadHistory.
//
// A conversation belongs to a scope (lib/support-bot/scope) and a channel: STAFF for a staff
// test, PORTAL for the merchant or banker asking for itself.

import type Anthropic from "@anthropic-ai/sdk";
import { rows } from "@/lib/pg";
import type { BotImage, BotUsage, TraceStep } from "@/lib/support-bot/bot";
import type { ScopeKey } from "@/lib/support-bot/scope";

type Msg = Anthropic.Beta.BetaMessageParam;
export type Channel = "STAFF" | "PORTAL";

export interface ConversationRow {
  id: string; merchant_code: string | null; scope_key: ScopeKey; channel: Channel; title: string | null;
  started_by: string; created_at: string; updated_at: string; questions: number;
}

const CONVERSATION_COLS = `c.id::text, c.merchant_code, c.scope_key, c.channel, c.title, c.started_by, c.created_at, c.updated_at,
  (SELECT COUNT(*)::int FROM support_bot_messages m WHERE m.conversation_id = c.id AND m.role = 'user' AND m.display IS NOT NULL) AS questions`;

export async function createConversation(scopeKey: ScopeKey, channel: Channel, title: string, by: string): Promise<string> {
  const code = scopeKey.startsWith("banker:") ? scopeKey.slice("banker:".length) : null;
  const r = await rows<{ id: string }>("merchant", `
    INSERT INTO support_bot_conversations (merchant_code, scope_key, channel, title, started_by) VALUES ($1, $2, $3, $4, $5) RETURNING id::text
  `, [code, scopeKey, channel, (title.trim() || "Screenshot").slice(0, 120), by]);
  return r[0].id;
}

export async function getConversation(id: string): Promise<ConversationRow | null> {
  const r = await rows<ConversationRow>("merchant", `SELECT ${CONVERSATION_COLS} FROM support_bot_conversations c WHERE c.id = $1::uuid`, [id]);
  return r[0] ?? null;
}

/** Newest first. `scopeKey` / `channel` null: any. */
export async function listConversations(f: { scopeKey: ScopeKey | null; channel: Channel | null }, limit = 50): Promise<ConversationRow[]> {
  return rows<ConversationRow>("merchant", `
    SELECT ${CONVERSATION_COLS} FROM support_bot_conversations c
     WHERE ($1::text IS NULL OR c.scope_key = $1) AND ($2::text IS NULL OR c.channel = $2)
     ORDER BY c.updated_at DESC LIMIT ${Math.min(limit, 200)}
  `, [f.scopeKey, f.channel]);
}

type StoredImage = { type: "image"; source: { type: "katana_attachment"; id: string } };
const isStoredImage = (b: unknown): b is StoredImage =>
  !!b && typeof b === "object" && (b as StoredImage).type === "image" && (b as StoredImage).source?.type === "katana_attachment";

/** The conversation as the model saw it, oldest first, to continue it: screenshots filled back in. */
export async function loadHistory(conversationId: string): Promise<Msg[]> {
  const [r, att] = await Promise.all([
    rows<{ role: "user" | "assistant"; content: Msg["content"] }>("merchant", `
      SELECT role, content FROM support_bot_messages WHERE conversation_id = $1::uuid ORDER BY seq
    `, [conversationId]),
    rows<{ id: string; media_type: string; data: Buffer }>("merchant", `
      SELECT id::text, media_type, data FROM support_bot_attachments WHERE conversation_id = $1::uuid
    `, [conversationId]),
  ]);
  const byId = new Map(att.map((a) => [a.id, a]));
  return r.map((m) => ({
    role: m.role,
    content: Array.isArray(m.content)
      ? (m.content as unknown[]).map((b) => {
          if (!isStoredImage(b)) return b;
          const a = byId.get(b.source.id);
          return a
            ? { type: "image", source: { type: "base64", media_type: a.media_type, data: a.data.toString("base64") } }
            : { type: "text", text: "[a screenshot that is no longer stored]" };
        }) as Msg["content"]
      : m.content,
  }));
}

export interface ShownMessage {
  id: string; role: "user" | "assistant"; text: string; attachments: string[] | null;
  trace: TraceStep[] | null; usage: BotUsage | null;
  feedback: number | null; feedback_note: string | null; feedback_by: string | null; created_by: string | null; created_at: string;
}

/** The questions and answers a person reads, oldest first. What the bot looked up is for staff only. */
export async function shownMessages(conversationId: string, staff: boolean): Promise<ShownMessage[]> {
  const r = await rows<ShownMessage>("merchant", `
    SELECT id::text, role, display AS text, attachments::text[] AS attachments, trace, usage, feedback, feedback_note, feedback_by, created_by, created_at
      FROM support_bot_messages WHERE conversation_id = $1::uuid AND display IS NOT NULL ORDER BY seq
  `, [conversationId]);
  return staff ? r : r.map((m) => ({ ...m, trace: null, usage: null }));
}

/**
 * Save one turn: every message it added, in order. The question is shown on its first message
 * (with its screenshots), the answer (with the lookups and usage) on its last, which is always an
 * assistant message (lib/support-bot/bot). Returns the answer row's id.
 */
export async function saveTurn(conversationId: string, turn: {
  added: Msg[]; question: string; images: BotImage[]; reply: string; trace: TraceStep[]; usage: BotUsage;
}, by: string): Promise<string> {
  const start = (await rows<{ n: number }>("merchant",
    `SELECT COALESCE(MAX(seq), 0)::int AS n FROM support_bot_messages WHERE conversation_id = $1::uuid`, [conversationId]))[0].n;

  // The screenshots go to their own rows; the question keeps a reference in their place.
  const ids: string[] = [];
  for (const img of turn.images) {
    const data = Buffer.from(img.data, "base64");
    const r = await rows<{ id: string }>("merchant", `
      INSERT INTO support_bot_attachments (conversation_id, media_type, bytes, data, created_by) VALUES ($1::uuid, $2, $3, $4, $5) RETURNING id::text
    `, [conversationId, img.media_type, data.length, data, by]);
    ids.push(r[0].id);
  }
  const added = turn.added.map((m, i) => {
    if (i !== 0 || !ids.length || !Array.isArray(m.content)) return m;
    let n = 0;
    return { ...m, content: (m.content as unknown[]).map((b) =>
      (b as { type?: string; source?: { type?: string } }).type === "image" && (b as { source?: { type?: string } }).source?.type === "base64" && n < ids.length
        ? { type: "image", source: { type: "katana_attachment", id: ids[n++] } } : b) } as Msg;
  });

  let answerId = "";
  for (const [i, m] of added.entries()) {
    const first = i === 0, last = i === added.length - 1;
    const r = await rows<{ id: string }>("merchant", `
      INSERT INTO support_bot_messages (conversation_id, seq, role, content, display, attachments, trace, usage, created_by)
      VALUES ($1::uuid, $2, $3, $4::jsonb, $5, $6::uuid[], $7::jsonb, $8::jsonb, $9) RETURNING id::text
    `, [conversationId, start + i + 1, m.role, JSON.stringify(m.content),
        first ? turn.question : last ? turn.reply : null,
        first && ids.length ? ids : null,
        last ? JSON.stringify(turn.trace) : null, last ? JSON.stringify(turn.usage) : null, by]);
    if (last) answerId = r[0].id;
  }
  await rows("merchant", `UPDATE support_bot_conversations SET updated_at = now() WHERE id = $1::uuid`, [conversationId]);
  return answerId;
}

export async function getAttachment(id: string): Promise<{ conversation_id: string; media_type: string; data: Buffer } | null> {
  const r = await rows<{ conversation_id: string; media_type: string; data: Buffer }>("merchant", `
    SELECT conversation_id::text, media_type, data FROM support_bot_attachments WHERE id = $1::uuid
  `, [id]);
  return r[0] ?? null;
}

/** The conversation an answer belongs to, to check who may rate it. */
export async function answerConversation(messageId: string): Promise<string | null> {
  const r = await rows<{ c: string }>("merchant", `
    SELECT conversation_id::text AS c FROM support_bot_messages WHERE id = $1::bigint AND role = 'assistant' AND display IS NOT NULL
  `, [messageId]);
  return r[0]?.c ?? null;
}

export async function setFeedback(messageId: string, rating: 1 | -1 | null, note: string | null, by: string): Promise<boolean> {
  const r = await rows<{ id: string }>("merchant", `
    UPDATE support_bot_messages SET feedback = $2, feedback_note = $3, feedback_by = $4, feedback_at = now()
     WHERE id = $1::bigint AND role = 'assistant' AND display IS NOT NULL RETURNING id::text
  `, [messageId, rating, note?.trim() || null, by]);
  return r.length > 0;
}
