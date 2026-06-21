// POST /api/v1/mfa/disable — turn off MFA (requires a valid current code if
// already enabled). BRD SEC-003.

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { disableMfa } from "@/lib/fifo-mfa";

export const dynamic = "force-dynamic";
const ALL = ["SUPER_ADMIN", "ADMIN", "PROVIDER", "MERCHANT", "OPERATOR", "COMPLIANCE", "FINANCE", "RISK", "SUPPORT"] as const;
const schema = z.object({ token: z.string().optional() });

export async function POST(req: Request) {
  const g = await gateOrResponse([...ALL]);
  if ("response" in g) return g.response;
  let body;
  try { body = schema.parse(await req.json().catch(() => ({}))); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  try {
    const ok = await disableMfa(g.session.email, body.token ?? "");
    if (!ok) return NextResponse.json({ error: "valid code required to disable" }, { status: 400 });
    return NextResponse.json({ ok: true, enabled: false });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
