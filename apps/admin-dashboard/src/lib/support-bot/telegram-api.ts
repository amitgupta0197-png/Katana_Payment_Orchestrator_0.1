// The Telegram Bot API calls the support bot makes (lib/support-bot/telegram): its own bot, not
// the admin reporting bot of lib/telegram. TELEGRAM_SUPPORT_API_BASE points the calls elsewhere
// (the integration test's stand-in); by default they go to api.telegram.org.
//
// Messages are sent as plain text (no parse_mode), so nothing in an answer is read as markup.

import { MAX_IMAGE_BYTES, sniffImage } from "@/lib/support-bot/images";
import type { BotImage } from "@/lib/support-bot/bot";

const base = () => (process.env.TELEGRAM_SUPPORT_API_BASE?.trim() || "https://api.telegram.org").replace(/\/$/, "");
const token = () => {
  const t = process.env.TELEGRAM_SUPPORT_BOT_TOKEN?.trim();
  if (!t) throw new Error("TELEGRAM_SUPPORT_BOT_TOKEN not set");
  return t;
};

async function call<T>(method: string, body: Record<string, unknown>, timeoutMs = 15_000): Promise<T | null> {
  try {
    const r = await fetch(`${base()}/bot${token()}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
    const j = await r.json().catch(() => null) as { ok?: boolean; result?: T; description?: string } | null;
    if (!r.ok || !j?.ok) { console.error(`[support-bot:telegram] ${method} ${r.status}: ${j?.description ?? ""}`); return null; }
    return j.result ?? null;
  } catch (e) {
    console.error(`[support-bot:telegram] ${method} failed: ${(e as Error).message}`);
    return null;
  }
}

/** Send one plain-text message, as a reply when `replyTo` is given. The sent message's id, or null. */
export async function tgSend(chatId: number, text: string, replyTo?: number | null): Promise<number | null> {
  const r = await call<{ message_id: number }>("sendMessage", {
    chat_id: chatId, text, disable_web_page_preview: true,
    ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
  });
  return r?.message_id ?? null;
}

let me: { id: number; username: string | null } | null = null;
/** The bot's own user id and @username, asked once. */
export async function tgMe(): Promise<{ id: number; username: string | null } | null> {
  if (me) return me;
  const r = await call<{ id: number; username?: string }>("getMe", {});
  if (r) me = { id: r.id, username: r.username ?? process.env.TELEGRAM_SUPPORT_BOT_USERNAME ?? null };
  return me;
}
/** Tests only: forget the cached bot. */
export function forgetTgMe() { me = null; }

/** Download a photo by its file_id, as a support bot image, or null when it can't be used. */
export async function tgPhoto(fileId: string): Promise<BotImage | null> {
  const f = await call<{ file_path?: string; file_size?: number }>("getFile", { file_id: fileId });
  if (!f?.file_path || (f.file_size ?? 0) > MAX_IMAGE_BYTES) return null;
  try {
    const r = await fetch(`${base()}/file/bot${token()}/${f.file_path}`, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return null;
    const bytes = Buffer.from(await r.arrayBuffer());
    if (bytes.length > MAX_IMAGE_BYTES) return null;
    const type = sniffImage(bytes);
    return type ? { media_type: type, data: bytes.toString("base64") } : null;
  } catch { return null; }
}
