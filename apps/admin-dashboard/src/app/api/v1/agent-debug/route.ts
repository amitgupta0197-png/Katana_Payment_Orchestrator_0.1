// POST /api/v1/agent-debug — DEBUG ONLY. The Android agent uploads a captured
// accessibility node tree (text + view-id + class + bounds) of a Paytm screen so its
// real structure can be inspected offline (e.g. to find a stable per-row selector for
// the payments list). Device-authenticated (x-sandbox), whitelisted in middleware.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { verifyDeviceRequest } from "@/lib/device-auth";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const raw = await req.text();
  // Was unauthenticated (audit H4): now requires a device signature (or the sandbox bypass).
  const auth = verifyDeviceRequest(req, raw);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
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
