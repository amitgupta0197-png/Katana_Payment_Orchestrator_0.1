// Per-banker pay-in limits (lib/payin-limits): ticket size, the day's total and the order rate.
//   GET  /api/merchants/[id]/payin-limits   the banker's own limits, the platform defaults, today's usage
//   POST /api/merchants/[id]/payin-limits   save them (audited)
// Amounts are rupees. Empty = no limit of its own: the platform default applies.
import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { wormAppend } from "@/lib/worm";
import { effectivePayinLimits, platformPayinLimits } from "@/lib/payin-limits";
import { getPayinLimits, getPayinUsage, setPayinLimits, type StoredPayinLimits } from "@/lib/payin-limits-store";

export const dynamic = "force-dynamic";

async function merchantCode(id: string): Promise<string | null> {
  const m = await rows<{ merchant_code: string }>("merchant", `SELECT merchant_code FROM merchants WHERE id = $1::uuid`, [id]);
  return m[0]?.merchant_code ?? null;
}

const view = (l: StoredPayinLimits) => ({
  min: l.min, max: l.max, daily: l.daily, max_tps: l.maxTps, set_by: l.setBy, set_at: l.setAt,
});

async function read(code: string) {
  const own = await getPayinLimits(code);
  const platform = platformPayinLimits();
  const e = effectivePayinLimits(own, platform);
  const usage = await getPayinUsage(code, true);
  return {
    limits: view(own),
    platform: { min: platform.min, upi_max: platform.upiMax, daily: platform.daily, max_tps: platform.maxTps },
    effective: { min: e.min, max: e.max, upi_max: e.upiMax, daily: e.daily, max_tps: e.maxTps },
    usage: { day_amount: usage.dayAmount },
  };
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "FINANCE", "RISK", "COMPLIANCE"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  try {
    const code = await merchantCode(id);
    if (!code) return NextResponse.json({ error: "merchant not found" }, { status: 404 });
    return NextResponse.json(await read(code));
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const amount = z.string().trim().regex(/^(\d+(\.\d{1,2})?)?$/, "rupees, e.g. 1000 or 1000.50").optional().nullable();
const schema = z.object({
  min: amount, max: amount, daily: amount,
  max_tps: z.string().trim().regex(/^\d*$/, "a whole number").optional().nullable(),
});
const num = (v?: string | null) => (v ? Number(v) : null);

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "RISK"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  try {
    const code = await merchantCode(id);
    if (!code) return NextResponse.json({ error: "merchant not found" }, { status: 404 });
    const before = view(await getPayinLimits(code));
    const saved = await setPayinLimits(code, {
      min: num(body.min), max: num(body.max), daily: num(body.daily), maxTps: num(body.max_tps),
    }, g.session.email);
    if (!saved.ok) return NextResponse.json({ error: saved.error }, { status: 400 });
    const after = await read(code);
    await wormAppend({
      actorId: g.session.user_id, actorEmail: g.session.email, action: "merchant.payin_limits.update",
      resourceType: "merchant", resourceId: id, before, after: { merchant_code: code, ...after.limits },
    }).catch(() => {});
    return NextResponse.json(after);
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
