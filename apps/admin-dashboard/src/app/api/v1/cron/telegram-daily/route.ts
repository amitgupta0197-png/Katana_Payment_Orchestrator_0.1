// POST /api/v1/cron/telegram-daily — pushes the combined daily report to every allowlisted
// admin Telegram chat. Cron-authenticated (x-cron-key, like the other crons); schedule it
// from the VPS crontab at the hour you want the summary. Whitelisted in middleware.

import { NextResponse } from "next/server";
import { telegramConfigured, broadcastToAdmins } from "@/lib/telegram";
import { fullReport } from "@/lib/reports";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const key = process.env.FIFO_CRON_KEY;
  if (!key) return NextResponse.json({ error: "cron disabled (FIFO_CRON_KEY unset)" }, { status: 503 });
  if (req.headers.get("x-cron-key") !== key) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!telegramConfigured()) return NextResponse.json({ error: "telegram not configured" }, { status: 503 });

  const text = await fullReport();
  const sent = await broadcastToAdmins(text);
  return NextResponse.json({ ok: true, sent });
}
