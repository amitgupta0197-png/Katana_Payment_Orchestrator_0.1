// GET /api/refunds — list
// POST /api/refunds — create + post journal
//
// WHO SEES AND REFUNDS WHAT. Katana staff: every merchant's. A merchant (PROVIDER persona): the
// refunds of its own bankers, read only. A banker (MERCHANT persona): its own orders only — an
// order of another merchant is "not found" to it, on the list and on a refund alike.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse, resolveProviderMerchants } from "@/lib/scope";
import { ownMerchantCode } from "@/lib/merchant-keys";
import { createRefund, RefundError } from "@/lib/refunds";
import type { Session } from "@/lib/auth";

/** The merchant codes a banker's session may act for: its scope id, and the code it normalises to. */
async function bankerScope(s: Session): Promise<string[]> {
  const own = await ownMerchantCode(s.scope_id ?? null);
  return [...new Set([s.scope_id, own].filter((c): c is string => !!c))];
}

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN","PROVIDER","MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;
  try {
    const wh: string[] = ["tenant_id='tenant-default'"];
    const params: unknown[] = [];
    if (s.persona === "MERCHANT") { params.push(await bankerScope(s)); wh.push(`merchant_id = ANY($${params.length}::text[])`); }
    // A merchant sees its own bankers' refunds, not every merchant's.
    if (s.persona === "PROVIDER") { params.push(await resolveProviderMerchants(s)); wh.push(`merchant_id = ANY($${params.length}::text[])`); }
    const refunds = await rows<any>("checkout", `
      SELECT refund_id::text, order_id::text, txn_id, merchant_id,
             amount_minor::text, currency, reason, status, partial,
             journal_id::text, COALESCE(requested_by,'') AS requested_by,
             requested_at, posted_at, COALESCE(failure_reason,'') AS failure_reason
        FROM refunds WHERE ${wh.join(" AND ")}
       ORDER BY requested_at DESC LIMIT 200
    `, params).catch(() => []);
    return NextResponse.json({ refunds });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const schema = z.object({
  txn_id: z.string().min(1),
  amount_minor: z.union([z.string().regex(/^[0-9]+$/, "a whole number of paise"), z.number().int().positive()]),
  // Accepted for older callers and ignored: the refund is in the order's own currency, and
  // whether it is partial follows from what has been refunded.
  currency: z.string().optional(),
  reason: z.string().min(1).max(300).default("customer_request"),
  partial: z.boolean().optional(),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN","MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    // A banker refunds its own orders only. A session with no scope refunds nothing.
    const merchantScope = s.persona === "MERCHANT" ? await bankerScope(s) : null;
    if (merchantScope && !merchantScope.length) return NextResponse.json({ error: "merchant session missing scope" }, { status: 403 });
    const result = await createRefund({
      txnId: body.txn_id, amountMinor: body.amount_minor, reason: body.reason,
      requestedBy: s.email, merchantScope,
    });
    return NextResponse.json(result);
  } catch (err) {
    const msg = (err as Error).message;
    if (err instanceof RefundError || /unbalanced/i.test(msg))
      return NextResponse.json({ error: msg }, { status: 400 });
    const e = pgError(err); return NextResponse.json(e.body, { status: e.status });
  }
}
