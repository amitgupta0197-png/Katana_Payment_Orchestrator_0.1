// POST /api/v1/agent-debug — DEBUG ONLY. The Android agent uploads a captured
// accessibility node tree (text + view-id + class + bounds) of a Paytm screen so its
// real structure can be inspected offline (e.g. to find a stable per-row selector for
// the payments list). Device-authenticated (x-sandbox), whitelisted in middleware.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const raw = await req.text();
  let body: { device_id?: string; merchant_id?: string; label?: string; body?: string };
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  try {
    await rows("vendorGateway", `
      INSERT INTO vendor_agent_debug (device_id, merchant_id, label, body)
      VALUES ($1, $2, $3, $4)
    `, [body.device_id ?? null, body.merchant_id ?? null, body.label ?? null, String(body.body ?? "").slice(0, 20000)]);
    return NextResponse.json({ ok: true });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
