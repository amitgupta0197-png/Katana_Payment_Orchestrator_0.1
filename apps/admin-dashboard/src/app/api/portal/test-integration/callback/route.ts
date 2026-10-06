// "Send me a test callback" on "Test my integration": one sample "payment.success" event to the
// banker's callback URL (lib/webhook-test: its own outbox row, never retried, marked
// X-Katana-Check: 1), and exactly what the server answered.
//   POST /api/portal/test-integration/callback { merchant_code }
// Only a banker in the session's own scope; anything else is "not found".

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { PORTAL_PERSONAS, inScope, portalScope } from "@/lib/portal-scope";
import { sendTestEvent } from "@/lib/webhook-test";
import { lastAttemptFor, takeTry, DRYRUN_PER_HOUR } from "@/lib/integration-dryrun-store";

export const dynamic = "force-dynamic";

const schema = z.object({ merchant_code: z.string().min(1).max(120) });

export async function POST(req: Request) {
  const g = await gateOrResponse(PORTAL_PERSONAS);
  if ("response" in g) return g.response;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    if (!inScope(await portalScope(g.session), body.merchant_code)) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (!takeTry(`callback:${body.merchant_code}`, DRYRUN_PER_HOUR))
      return NextResponse.json({ error: "Too many test callbacks this hour. Try again later.", code: "RATE_LIMITED" }, { status: 429 });
    const r = await sendTestEvent(body.merchant_code, "payment.success", g.session.email);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
    const a = await lastAttemptFor(r.outbox_id);
    return NextResponse.json({
      ok: r.result.ok, target_url: r.target_url, version: r.version,
      http_status: a?.http_status ?? r.result.http_status, duration_ms: a?.duration_ms ?? r.result.latency_ms,
      body: a?.body ?? null, error: a?.error ?? r.result.error,
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
