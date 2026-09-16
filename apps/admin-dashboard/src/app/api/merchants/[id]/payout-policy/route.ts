// Per-merchant payout policy (Onboard Merchant: allowed rails, limits, approval rule).
//   GET  /api/merchants/[id]/payout-policy   current policy + whether the merchant is suspended
//   POST /api/merchants/[id]/payout-policy   save it (audited)
// Amounts are rupees in, rupees out; stored in paise. Empty = no limit.
import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { toMinor, fromMinor } from "@/lib/money";
import { wormAppend } from "@/lib/worm";
import { getPayoutPolicy, isMerchantSuspended, savePayoutPolicy, PAYOUT_RAILS, type PayoutPolicy } from "@/lib/payout-policy";

export const dynamic = "force-dynamic";

async function merchantCode(id: string): Promise<string | null> {
  const m = await rows<{ merchant_code: string }>("merchant", `SELECT merchant_code FROM merchants WHERE id = $1::uuid`, [id]);
  return m[0]?.merchant_code ?? null;
}

const rupees = (v: bigint | null) => (v == null ? null : fromMinor(v, "INR"));
const view = (p: PayoutPolicy) => ({
  min_txn: rupees(p.min_txn_minor), max_txn: rupees(p.max_txn_minor), daily: rupees(p.daily_minor),
  allowed_rails: p.allowed_rails ?? [], approval_rule: p.approval_rule,
  updated_by: p.updated_by, updated_at: p.updated_at,
});

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "FINANCE", "RISK", "COMPLIANCE"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  try {
    const code = await merchantCode(id);
    if (!code) return NextResponse.json({ error: "merchant not found" }, { status: 404 });
    return NextResponse.json({ policy: view(await getPayoutPolicy(code)), suspended: await isMerchantSuspended(code) });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const amount = z.string().trim().regex(/^(\d+(\.\d{1,2})?)?$/, "rupees, e.g. 1000 or 1000.50").optional().nullable();
const schema = z.object({
  min_txn: amount, max_txn: amount, daily: amount,
  allowed_rails: z.array(z.enum(PAYOUT_RAILS as [string, ...string[]])).max(4).default([]),
  approval_rule: z.enum(["AUTO", "MAKER_CHECKER"]).default("AUTO"),
});
const toPaise = (v?: string | null) => (v ? toMinor(v, "INR") : null);

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "RISK"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  const min = toPaise(body.min_txn), max = toPaise(body.max_txn), daily = toPaise(body.daily);
  if (min != null && max != null && min > max) return NextResponse.json({ error: "minimum is above maximum" }, { status: 400 });
  if (max != null && daily != null && max > daily) return NextResponse.json({ error: "maximum per payout is above the daily limit" }, { status: 400 });
  try {
    const code = await merchantCode(id);
    if (!code) return NextResponse.json({ error: "merchant not found" }, { status: 404 });
    const before = view(await getPayoutPolicy(code));
    await savePayoutPolicy({
      merchant_id: code, min_txn_minor: min, max_txn_minor: max, daily_minor: daily,
      allowed_rails: body.allowed_rails.length ? body.allowed_rails as PayoutPolicy["allowed_rails"] : null,
      approval_rule: body.approval_rule, updated_by: g.session.email,
    });
    const after = view(await getPayoutPolicy(code));
    await wormAppend({
      actorId: g.session.user_id, actorEmail: g.session.email, action: "merchant.payout_policy.update",
      resourceType: "merchant", resourceId: id, before, after: { merchant_code: code, ...after },
    }).catch(() => {});
    return NextResponse.json({ policy: after });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
