// EMAIL ingestion poller. A scheduler (crontab) hits this every ~1 min with the
// shared x-cron-key. It polls the configured Gmail/IMAP inbox for new payment-received
// emails and feeds them into the reconciler (see lib/email-ingest). No-op (200) when
// EMAIL_INGEST_* is not configured. Whitelisted in middleware (PUBLIC_API).

import { NextResponse } from "next/server";
import { pollAllInboxes, debugEmail, startWatchAll } from "@/lib/email-ingest";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const key = process.env.FIFO_CRON_KEY;
  if (!key) return NextResponse.json({ error: "cron disabled (FIFO_CRON_KEY unset)" }, { status: 503 });
  if (req.headers.get("x-cron-key") !== key) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  try {
    const sp = new URL(req.url).searchParams;
    if (sp.get("debug") === "1") return NextResponse.json(await debugEmail());
    if (sp.get("watch") === "1") return NextResponse.json(await startWatchAll()); // renew Gmail push watches
    const r = await pollAllInboxes();
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
