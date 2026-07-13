// POST /api/v1/telegram/webhook — Telegram calls this with each update. The bot answers
// on-demand admin report commands. Security: (1) the request must carry Telegram's secret
// token header (set when we register the webhook), and (2) the chat must be on the admin
// allowlist — everyone else gets nothing but their own chat id (so they can be added).
// Whitelisted in middleware PUBLIC_API (Telegram has no session cookie; it self-authenticates
// via the secret header). Always returns 200 so Telegram doesn't retry.

import { NextResponse } from "next/server";
import { telegramConfigured, verifyWebhookSecret, isAdminChat, sendMessage } from "@/lib/telegram";
import { collectionsToday, captureHealth, settlementsSummary, partnerInquiries, fullReport } from "@/lib/reports";

export const dynamic = "force-dynamic";

const HELP = [
  "<b>Katana admin bot</b>",
  "/today — today's collections",
  "/captures — RRN capture health",
  "/settlements — pending & settled",
  "/leads — partner inquiries",
  "/report — everything at once",
].join("\n");

const ok = () => NextResponse.json({ ok: true });

export async function POST(req: Request) {
  if (!telegramConfigured()) return ok();
  if (!verifyWebhookSecret(req.headers.get("x-telegram-bot-api-secret-token"))) {
    return NextResponse.json({ error: "forbidden" }, { status: 401 });
  }

  let update: any;
  try { update = await req.json(); } catch { return ok(); }

  const msg = update?.message ?? update?.edited_message;
  const chatId = msg?.chat?.id;
  const text: string = (msg?.text ?? "").trim();
  if (!chatId || !text) return ok();

  // strip @botname and args; commands come as "/today" or "/today@KatanaBot"
  const cmd = text.split(/\s+/)[0].split("@")[0].toLowerCase();

  // /start helps setup: anyone can see their own chat id to be added to the allowlist.
  if (cmd === "/start" || cmd === "/id") {
    await sendMessage(chatId,
      isAdminChat(chatId)
        ? `✅ You're an admin.\n\n${HELP}`
        : `Your chat ID is <code>${chatId}</code>.\nAsk an admin to add it to <code>TELEGRAM_ADMIN_CHAT_IDS</code>.`);
    return ok();
  }

  // Everything else requires the allowlist.
  if (!isAdminChat(chatId)) {
    await sendMessage(chatId, "⛔ Not authorized. Send /start to get your chat ID.");
    return ok();
  }

  try {
    switch (cmd) {
      case "/today":       await sendMessage(chatId, await collectionsToday()); break;
      case "/captures":    await sendMessage(chatId, await captureHealth()); break;
      case "/settlements": await sendMessage(chatId, await settlementsSummary()); break;
      case "/leads":       await sendMessage(chatId, await partnerInquiries()); break;
      case "/report":      await sendMessage(chatId, await fullReport()); break;
      case "/help":        await sendMessage(chatId, HELP); break;
      default:             await sendMessage(chatId, `Unknown command.\n\n${HELP}`);
    }
  } catch (e) {
    await sendMessage(chatId, "⚠️ Something went wrong building that report.");
    console.error("[telegram] command error:", (e as Error).message);
  }
  return ok();
}
