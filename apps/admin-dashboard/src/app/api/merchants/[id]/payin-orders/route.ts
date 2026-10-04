// A merchant's Katana Pay pay-in orders for the merchant-module operations view:
// which payments are currently active, their mode (QR/non-QR), active receiver
// VPA and backup-pool health. SUPER_ADMIN/PROVIDER (scoped)/MERCHANT (own).
//   GET  — list this merchant's pay-in orders (operations view).
//   POST — create a Katana Pay S2S pay-in order FOR this merchant (the merchant-scoped
//          equivalent of the cockpit's "Create S2S order"; tagged with merchant_id
//          so it routes through the merchant's sub-MID, honours block/high-amount
//          risk rules, and shows up in the operations list above).

import { NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "crypto";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { resolveMerchantScope } from "@/lib/merchant-keys";
import { createKatanaOrder, MerchantBlockedError, PayinSetupError } from "@/lib/katana-order";
import { NoMidAvailableError } from "@/lib/mid-switch";
import { PayinLimitError, payinLimitBody } from "@/lib/payin-limits";
import { getLivemode } from "@/lib/mode";
import { activationErrorResponse } from "@/lib/live-activation";
import { getGatewayMid, payuKeySalt } from "@/lib/gateway-creds";
import { PayuIntentError, intentClientFrom } from "@/lib/payu-intent";
import { payinConnectorFor } from "@/lib/payin-providers";
import { merchantSafeChannel, merchantSafeError, seesGatewayNames } from "@/lib/merchant-safe";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  const scope = await resolveMerchantScope(id, g.session);
  if ("response" in scope) return scope.response;

  try {
    const livemode = await getLivemode();
    const orders = await rows<any>("vendorGateway", `
      SELECT id::text, order_id, vendor, amount::float AS amount, currency_code, status,
             COALESCE(rrn,'') AS rrn, COALESCE(sub_mid_code,'') AS sub_mid_code,
             meta, created_at, livemode
        FROM vendor_payin_orders
       WHERE merchant_id = $1
         AND livemode = $2   -- follows the dashboard's Test / Live switch
       ORDER BY created_at DESC LIMIT 100
    `, [scope.code, livemode]).catch(() => []);

    const shaped = orders.map((o: any) => {
      const m = o.meta ?? {};
      const pool = Array.isArray(m.vpa_pool) ? m.vpa_pool : [];
      return {
        id: o.id, order_id: o.order_id, vendor: o.vendor, amount: o.amount, currency_code: o.currency_code,
        status: o.status, rrn: o.rrn, sub_mid_code: o.sub_mid_code, created_at: o.created_at,
        livemode: o.livemode !== false,
        mode: m.mode ?? "QR",
        active_vpa: m.receiver_vpa ?? null,
        vpa_total: pool.length,
        vpa_remaining: pool.filter((p: any) => p.status === "READY").length,
        hold: m.hold === true,
        hold_reason: m.hold_reason ?? null,
        terminal: ["SUCCESS", "SUCCEEDED", "FAILED", "EXPIRED"].includes(o.status),
      };
    });
    // Hosted-checkout orders (POST /api/pay, e.g. a merchant's own shop) live in checkout_orders.
    // They join the full history only: the operations actions above are Katana Pay's.
    const checkout = await rows<any>("checkout", `
      SELECT o.id::text, o.txn_id, o.amount::float AS amount, o.currency, o.status, o.created_at, o.livemode,
             d.provider, COALESCE(d.bank_ref_num,'') AS bank_ref
        FROM checkout_orders o
        LEFT JOIN payment_details d ON d.order_id = o.id
       WHERE o.merchant_id = $1
         AND o.livemode = $2
       ORDER BY o.created_at DESC LIMIT 100
    `, [scope.code, livemode]).catch(() => []);
    const hosted = checkout.map((o: any) => ({
      id: o.id, order_id: o.txn_id, vendor: o.provider ?? "CHECKOUT", amount: o.amount, currency_code: o.currency,
      // A gateway can report a reference before the money lands; show it only once paid.
      status: o.status, rrn: o.status === "SUCCESS" ? o.bank_ref : "", sub_mid_code: "", created_at: o.created_at,
      livemode: o.livemode !== false, mode: "HOSTED", active_vpa: null, vpa_total: 0, vpa_remaining: 0,
      hold: false, hold_reason: null, source: "checkout",
      terminal: ["SUCCESS", "FAILED"].includes(o.status),
    }));

    // A provider or merchant never sees which gateway took a payment (lib/merchant-safe).
    if (!seesGatewayNames(g.session.persona))
      for (const o of [...shaped, ...hosted] as { vendor: string }[]) o.vendor = merchantSafeChannel(o.vendor);

    const live = shaped.filter((o: any) => !o.terminal);
    const all = [...shaped, ...hosted]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 100);
    return NextResponse.json({ merchant_code: scope.code, live, all });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const createSchema = z.object({
  amount: z.coerce.number().positive().max(1_000_000),
  currency: z.string().default("INR"),
  mode: z.enum(["QR", "INTENT"]).optional(),
  receiver_vpas: z.array(z.string()).max(30).optional(), // payee pool (backup failover)
  customer_vpa: z.string().optional(),                   // sender / payer VPA
  customer_phone: z.string().optional(),
  order_ref: z.string().max(60).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  const scope = await resolveMerchantScope(id, g.session);
  if ("response" in scope) return scope.response;

  let body;
  try { body = createSchema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  // Default the receiver VPA pool to the merchant's configured Katana Pay settlement
  // VPA when the caller didn't supply one, so an operator can create an order with
  // just an amount.
  let receiverVpas = body.receiver_vpas?.map((v) => v.trim()).filter(Boolean) ?? [];
  if (!receiverVpas.length) {
    const cfg = await rows<{ settlement_vpa: string | null }>(
      "merchant", `SELECT katana_pay->>'settlement_vpa' AS settlement_vpa FROM merchant_payment_config WHERE merchant_code = $1`,
      [scope.code],
    ).catch(() => []);
    const v = cfg[0]?.settlement_vpa?.trim();
    if (v) receiverVpas = [v];
  }
  // A dashboard-created order follows the Test / Live switch (live by default). A test order
  // always pays the sandbox UPI ID, so it needs no receiver.
  const livemode = await getLivemode();
  // A merchant whose pay-in gateway issues UPI intents (PayU, Razorpay, Cashfree, PhonePe, Paytm)
  // is paid through the gateway's collection account, so it needs no receiver.
  const gw = livemode ? await getGatewayMid(scope.code).catch(() => null) : null;
  const viaGateway = !!payuKeySalt(gw) || !!payinConnectorFor(gw)?.upiIntent;
  if (!receiverVpas.length && livemode && !viaGateway)
    return NextResponse.json({ error: "no receiver VPA — add one here or set a settlement VPA in payment config" }, { status: 400 });

  try {
    const orderId = body.order_ref?.trim()
      || `KP-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 4).toUpperCase()}`;
    const r = await createKatanaOrder({
      orderId,
      amount: body.amount,
      currency: body.currency,
      merchantId: scope.code,
      receiverVpas,
      mode: body.mode,
      customerVpa: body.customer_vpa ?? null,
      customerPhone: body.customer_phone ?? null,
      livemode,
      client: intentClientFrom(req),
    });
    if (r.reused) return NextResponse.json({ error: "order_ref already used" }, { status: 409 });
    if (!r.order) return NextResponse.json({ error: "order create failed" }, { status: 500 });
    return NextResponse.json({ order: r.order, livemode, deeplinks: r.deeplinks, upi_intent: r.upiIntent, qr_payload: r.upiIntent });
  } catch (err) {
    if (err instanceof MerchantBlockedError)
      return NextResponse.json({ error: `${err.message} — new pay-ins rejected`, code: err.code }, { status: 403 });
    if (err instanceof PayinLimitError) return NextResponse.json(payinLimitBody(err.breach), { status: err.status });
    if (err instanceof NoMidAvailableError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    if (err instanceof PayuIntentError || err instanceof PayinSetupError) {
      // Operators get the gateway's own words; a provider or merchant gets the scrubbed text.
      const error = seesGatewayNames(g.session.persona) ? err.message : merchantSafeError(err.message, "api/merchants/payin-orders");
      return NextResponse.json({ error }, { status: err.status });
    }
    const a = activationErrorResponse(err);   // a live order before live mode is activated
    if (a) return NextResponse.json(a.body, { status: a.status });
    const e = pgError(err); return NextResponse.json(e.body, { status: e.status });
  }
}
