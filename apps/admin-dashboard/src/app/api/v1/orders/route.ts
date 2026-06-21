// POST /api/v1/orders — create a FIFO payment order (BRD §19, FR-001/002).
// Merchant creates own orders; SUPER_ADMIN/ADMIN may create on a merchant's behalf.
// GET  /api/v1/orders — list orders (scoped by persona).

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse, resolveProviderMerchants } from "@/lib/scope";
import { toMinor } from "@/lib/money";
import { createOrder } from "@/lib/fifo";

export const dynamic = "force-dynamic";

const schema = z.object({
  merchant_id: z.string().optional(),
  amount: z.union([z.number().positive(), z.string().min(1)]),
  currency: z.string().default("INR"),
  direction: z.enum(["PAYIN", "PAYOUT"]).default("PAYIN"),
  settlement_mode: z.enum(["BANK", "USDT", "WALLET", "UPI"]).default("BANK"),
  purpose: z.string().optional(),
  priority: z.number().int().optional(),
  customer: z.object({
    name: z.string().optional(), phone: z.string().optional(), email: z.string().optional(),
  }).optional(),
  device_fingerprint: z.string().optional(),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["MERCHANT", "SUPER_ADMIN", "ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;

  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  const merchantId = s.persona === "MERCHANT" ? s.scope_id! : body.merchant_id;
  if (!merchantId) return NextResponse.json({ error: "merchant_id required" }, { status: 400 });

  const currency = body.currency.toUpperCase();
  const amountStr = typeof body.amount === "number" ? body.amount.toString() : body.amount;
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;

  try {
    const r = await createOrder({
      merchantId, direction: body.direction, amountMinor: toMinor(amountStr, currency), currency,
      settlementMode: body.settlement_mode, purpose: body.purpose, priority: body.priority,
      customerName: body.customer?.name, customerPhone: body.customer?.phone, customerEmail: body.customer?.email,
      deviceIp: ip ?? undefined, deviceFingerprint: body.device_fingerprint, actor: s.email,
    });
    if (r.error) return NextResponse.json({ error: r.error }, { status: r.status ?? 400 });
    return NextResponse.json({ order: r.order }, { status: 201 });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

export async function GET(req: Request) {
  const g = await gateOrResponse(["MERCHANT", "PROVIDER", "OPERATOR", "SUPER_ADMIN", "ADMIN", "FINANCE", "COMPLIANCE", "RISK"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const url = new URL(req.url);
  const status = url.searchParams.get("status");

  try {
    const params: unknown[] = ["tenant-default"];
    let where = "tenant_id = $1";
    if (s.persona === "MERCHANT") { where += ` AND merchant_id = $${params.length + 1}`; params.push(s.scope_id); }
    else if (s.persona === "PROVIDER") {
      const ids = await resolveProviderMerchants(s);
      if (!ids.length) return NextResponse.json({ orders: [] });
      where += ` AND merchant_id = ANY($${params.length + 1}::text[])`; params.push(ids);
    }
    if (status) { where += ` AND status = $${params.length + 1}`; params.push(status); }

    const orders = await rows<any>("fifo", `
      SELECT id, order_ref, merchant_id, direction, amount_minor::text, currency, settlement_mode,
             status, risk_score, risk_decision, txn_ref, utr, tx_hash,
             usdt_network, usdt_rate, usdt_amount, created_at, completed_at
        FROM fifo_orders WHERE ${where}
       ORDER BY created_at DESC LIMIT 200
    `, params);
    return NextResponse.json({ orders });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
