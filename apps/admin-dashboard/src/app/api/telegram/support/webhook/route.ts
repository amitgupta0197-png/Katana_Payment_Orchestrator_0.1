// POST /api/telegram/support/webhook — Telegram delivers each update of the support bot here
// (lib/support-bot/telegram). Public in the middleware: Telegram has no session; it proves itself
// with the secret_token given at setWebhook, echoed in X-Telegram-Bot-Api-Secret-Token.
//
// Answered 200 at once and handled after the response (next/server `after`): an answer can take
// 10–30 s (the burst wait plus the model), and Telegram would retry a slow webhook. The server is
// a long-running `next start`, so the work after the response runs to the end. A retried update
// is dropped by its update_id.
//
// Inert (404) unless SUPPORT_BOT_TELEGRAM=1 and TELEGRAM_SUPPORT_BOT_TOKEN and
// TELEGRAM_SUPPORT_WEBHOOK_SECRET are set.

import { after, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { telegramEnabled } from "@/lib/support-bot/telegram-rules";
import { handleTelegramUpdate } from "@/lib/support-bot/telegram";
import { recordSecurityEvent } from "@/lib/security-event";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

function secretOk(got: string | null): boolean {
  const want = process.env.TELEGRAM_SUPPORT_WEBHOOK_SECRET?.trim() ?? "";
  if (!want || !got) return false;
  const a = Buffer.from(got), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  if (!telegramEnabled()) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!secretOk(req.headers.get("x-telegram-bot-api-secret-token"))) {
    await recordSecurityEvent({ risk: "BAD_SIGNATURE", detail: "support bot Telegram webhook called without its secret token" });
    return NextResponse.json({ error: "forbidden" }, { status: 401 });
  }
  let update: unknown;
  try { update = await req.json(); } catch { return NextResponse.json({ ok: true }); }
  after(() => handleTelegramUpdate(update));
  return NextResponse.json({ ok: true });
}
