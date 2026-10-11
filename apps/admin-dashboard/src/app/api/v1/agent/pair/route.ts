// POST /api/v1/agent/pair — a Katana Agent phone redeems a pairing code (lib/agent-pair) and gets
// its setup: banker code, server, the payment app to read and, for BharatPe, the MID's key +
// secret. Public (the one-time, 15-minute code is the credential); whitelisted in middleware.
// Body { code, device_id, install_id? }. A failed code is answered the same whatever the reason,
// and a few wrong codes from one address in a minute are refused.

import { NextResponse } from "next/server";
import { z } from "zod";
import { normalisePairCode } from "@/lib/agent-pair";
import { PairError, redeemPairCode } from "@/lib/agent-pair-store";
import { wormAppend } from "@/lib/worm";

export const dynamic = "force-dynamic";

const schema = z.object({ code: z.string().max(40), device_id: z.string().min(1).max(80), install_id: z.string().max(80).optional() });
const misses = new Map<string, number[]>();

export async function POST(req: Request) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "?";
  const now = Date.now();
  const recent = (misses.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= 10) return NextResponse.json({ error: "too many tries — wait a minute" }, { status: 429 });
  let body;
  try { body = schema.parse(await req.json()); } catch { return NextResponse.json({ error: "send code and device_id" }, { status: 400 }); }
  const code = normalisePairCode(body.code);
  const fail = (status: number, error: string) => { misses.set(ip, [...recent, now]); return NextResponse.json({ error }, { status }); };
  if (!code) return fail(404, "This pairing code is wrong, already used or expired. Ask for a new one.");
  try {
    const base = (process.env.PUBLIC_BASE_URL ?? new URL(req.url).origin).replace(/\/$/, "");
    const p = await redeemPairCode(code, body.device_id, base);
    wormAppend({ actorId: null, actorEmail: `device:${body.device_id}`, action: "merchant.agent_paired",
      resourceType: "merchant", resourceId: p.merchant_code, before: null,
      after: { device_id: body.device_id, install_id: body.install_id ?? null, capture_app: p.capture_app, bharatpe_key: !!p.bharatpe } }).catch(() => {});
    return NextResponse.json({ ok: true, ...p }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof PairError) return fail(e.status, e.message);
    return NextResponse.json({ error: "could not pair — try again" }, { status: 500 });
  }
}
