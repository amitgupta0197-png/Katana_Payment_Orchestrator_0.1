// Telegram bot helper for the admin reporting bot. The bot answers on-demand report
// commands (via the /api/v1/telegram/webhook route) and pushes a scheduled daily summary
// (via /api/v1/cron/telegram-daily). It reports FINANCIAL data, so access is locked to an
// explicit allowlist of admin chat IDs — the bot silently ignores everyone else.
//
// Server env (.env.local on the VPS — set by the operator, never committed):
//   TELEGRAM_BOT_TOKEN=123456:ABC...        (from @BotFather)
//   TELEGRAM_ADMIN_CHAT_IDS=11111111,22222  (comma-separated numeric chat ids allowed)
//   TELEGRAM_WEBHOOK_SECRET=<random string>  (echoed by Telegram in a header; we verify it)

const API = "https://api.telegram.org";

export function telegramConfigured(): boolean {
  return !!process.env.TELEGRAM_BOT_TOKEN;
}

function token(): string {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t) throw new Error("TELEGRAM_BOT_TOKEN not set");
  return t;
}

// Allowlisted admin chat ids. Anyone not in this list gets no data.
export function adminChatIds(): string[] {
  return (process.env.TELEGRAM_ADMIN_CHAT_IDS ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
}

export function isAdminChat(chatId: string | number): boolean {
  return adminChatIds().includes(String(chatId));
}

// Telegram echoes this on every webhook call in the X-Telegram-Bot-Api-Secret-Token
// header (set when we register the webhook). Reject anything that doesn't match, so only
// Telegram — not a random caller hitting our public URL — can drive the bot.
export function verifyWebhookSecret(headerValue: string | null): boolean {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) return false;                 // not configured → reject (fail closed)
  return headerValue === secret;
}

// HTML parse mode — only these three chars need escaping (simpler than MarkdownV2).
export function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function sendMessage(chatId: string | number, text: string): Promise<void> {
  const r = await fetch(`${API}/bot${token()}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    console.error(`[telegram] sendMessage ${r.status}: ${body}`);
  }
}

// Fan a message out to every allowlisted admin (used by the scheduled daily push).
export async function broadcastToAdmins(text: string): Promise<number> {
  const ids = adminChatIds();
  await Promise.allSettled(ids.map((id) => sendMessage(id, text)));
  return ids.length;
}

// Format paise/rupee numbers as ₹1,23,456.78 (Indian grouping).
export function inr(n: number | string | null | undefined): string {
  const v = Number(n ?? 0);
  return "₹" + v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
