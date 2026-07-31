// Banker's own advance purchases.
//
//   GET  — read-only list, scoped to the banker's own scope_id.
//   POST — confirm the DT was received (flow change 2026-07-31). This is the
//          FUNDS_SUBMITTED → ACTIVE step that materialises the 60/40 quota + reserve.
//          ADMIN/FINANCE keep the same ability via /api/v1/dt/purchases/{id} as an
//          override, so an unavailable banker cannot deadlock the flow.
//
// Every other lifecycle transition stays admin-side. This route deliberately accepts
// ONE target status: a banker can confirm receipt, not approve, reject or close.
import { NextResponse } from "next/server";
import { z } from "zod";
import { gateOrResponse } from "@/lib/scope";
import { rows } from "@/lib/pg";
import { listPurchases, getPurchase, transitionPurchase } from "@/lib/dt";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["BANKER"]);
  if ("response" in g) return g.response;
  const bankerId = g.session.scope_id;
  if (!bankerId) return NextResponse.json({ error: "BANKER session missing scope_id" }, { status: 400 });
  const purchases = await listPurchases({ banker_id: bankerId });
  return NextResponse.json({ purchases });
}

// The banker approves that the USDT was ACCEPTED — that approval is what activates
// the lot. USDT detail is optional so a lot funded another way is not blocked, but
// when a network is given the amount must come with it: a network with no amount
// records a payment that cannot be reconciled.
const schema = z.object({
  id: z.string().uuid(),
  reference_no: z.string().trim().max(120).optional(),
  usdt_network: z.enum(["TRC20", "ERC20", "BEP20"]).optional(),
  usdt_amount: z.number().positive().optional(),
  usdt_tx_hash: z.string().trim().max(200).optional(),
  usdt_wallet: z.string().trim().max(200).optional(),
}).refine((v) => !v.usdt_network || v.usdt_amount !== undefined, {
  message: "usdt_amount is required when a USDT network is given",
  path: ["usdt_amount"],
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["BANKER"]);
  if ("response" in g) return g.response;
  const bankerId = g.session.scope_id;
  if (!bankerId) return NextResponse.json({ error: "BANKER session missing scope_id" }, { status: 400 });

  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  // Ownership check BEFORE the transition — the id comes from the client, so without
  // this a banker could confirm another banker's purchase and activate their lot.
  const own = await rows<{ banker_id: string; status: string }>("provider",
    `SELECT banker_id, status FROM dt_purchases WHERE id = $1::uuid`, [body.id]).catch(() => []);
  if (!own.length) return NextResponse.json({ error: "purchase not found" }, { status: 404 });
  if (own[0].banker_id !== bankerId)
    return NextResponse.json({ error: "that purchase belongs to another banker" }, { status: 403 });
  if (own[0].status !== "FUNDS_SUBMITTED")
    return NextResponse.json({
      error: `only a purchase awaiting your confirmation can be confirmed (this one is ${own[0].status})`,
    }, { status: 409 });

  // Snapshot the applicable INR/USDT rate at acceptance so a later rate change never
  // re-values a lot that is already active. Newest effective, non-expired row wins —
  // the same rule /api/usdt-rates uses to pick the current rate.
  let usdtRate: number | null = null;
  let usdtInr: number | null = null;
  if (body.usdt_network && body.usdt_amount !== undefined) {
    const rate = await rows<{ settlement_rate: number }>("provider", `
      SELECT settlement_rate::float AS settlement_rate
        FROM provider_usdt_rates
       WHERE network = $1 AND effective_from <= now() AND (expiry_at IS NULL OR expiry_at > now())
       ORDER BY effective_from DESC LIMIT 1
    `, [body.usdt_network]).catch(() => []);
    if (!rate.length)
      return NextResponse.json({
        error: `no active USDT rate for ${body.usdt_network} — ask Katana to declare today's rate before confirming`,
      }, { status: 400 });
    usdtRate = rate[0].settlement_rate;
    usdtInr = +(body.usdt_amount * usdtRate).toFixed(2);
  }

  const r = await transitionPurchase(body.id, "ACTIVE", g.session.email, { reference_no: body.reference_no });
  if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.status });

  // Who confirmed receipt, distinct from approved_by (the maker-checker approval),
  // plus what was actually accepted on-chain.
  await rows("provider", `
    UPDATE dt_purchases
       SET received_confirmed_by = $2, received_confirmed_at = now(),
           usdt_network = COALESCE($3, usdt_network),
           usdt_amount  = COALESCE($4, usdt_amount),
           usdt_rate    = COALESCE($5, usdt_rate),
           usdt_inr_value = COALESCE($6, usdt_inr_value),
           usdt_tx_hash = COALESCE($7, usdt_tx_hash),
           usdt_wallet  = COALESCE($8, usdt_wallet)
     WHERE id = $1::uuid
  `, [body.id, g.session.email, body.usdt_network ?? null, body.usdt_amount ?? null,
      usdtRate, usdtInr, body.usdt_tx_hash ?? null, body.usdt_wallet ?? null]).catch(() => {});

  const purchase = await getPurchase(body.id);
  // Surface any gap between the INR advance and what the USDT actually converts to,
  // rather than letting an under-payment activate a full-size lot unremarked.
  const expected = (purchase as any)?.total_amount ?? null;
  const shortfall = expected !== null && usdtInr !== null ? +(expected - usdtInr).toFixed(2) : null;

  return NextResponse.json({
    ok: true,
    purchase,
    usdt: usdtInr === null ? null : { rate: usdtRate, inr_value: usdtInr, expected_inr: expected, shortfall },
  });
}
