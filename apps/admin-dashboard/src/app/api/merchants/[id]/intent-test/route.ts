// Intent live test: a real, live pay-in on a banker's own pay-in gateway, made by Katana staff
// from the banker page's Intent section, with a payment link to pay it from a phone.
//   GET  — this banker's recent live tests and the verifying limits. Staff.
//   POST { amount, customer_phone? } — create one. SUPER_ADMIN / ADMIN.
//
// It is an ordinary live order on the Intent flow (createKatanaOrder with flow INTENT), so it goes
// through everything a merchant's order does: block, live mode, limits, the MID switch and the
// go-live checklist (an account still VERIFYING takes only small payments). What differs: it is
// marked `meta.staff_test`, and the banker's server is not sent a callback for it
// (lib/merchant-callback), because the banker never made it. A paid test is what the go-live
// checklist's "a real payment was confirmed" step looks for. STAFF ONLY: it names the gateway.

import { NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "crypto";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { STAFF_PERSONAS } from "@/lib/portal-scope";
import { resolveMerchantScope } from "@/lib/merchant-keys";
import {
  createKatanaOrder, MerchantBlockedError, OrderRefTakenError, PayinFlowError, PayinSetupError,
} from "@/lib/katana-order";
import { NoMidAvailableError } from "@/lib/mid-switch";
import { PayinLimitError, payinLimitBody } from "@/lib/payin-limits";
import { activationErrorResponse } from "@/lib/live-activation";
import { AccountNotLiveError, VERIFY_MAX_AMOUNT, VERIFY_MAX_ORDERS } from "@/lib/gateway-golive";
import { PayuIntentError, intentClientFrom } from "@/lib/payu-intent";
import { getEffectiveFlow } from "@/lib/payin-flow-store";
import { getGatewayMidStatus } from "@/lib/gateway-creds";
import { KATANA_TERMINAL } from "@/lib/katana-pay";

export const dynamic = "force-dynamic";

const base = () => (process.env.PUBLIC_BASE_URL ?? "https://katanapay.co").replace(/\/$/, "");

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(STAFF_PERSONAS);
  if ("response" in g) return g.response;
  const scope = await resolveMerchantScope((await params).id, g.session);
  if ("response" in scope) return scope.response;
  try {
    const tests = await rows<any>("vendorGateway", `
      SELECT id::text, order_id, amount::float AS amount, status, COALESCE(rrn,'') AS rrn, created_at, updated_at,
             meta->'staff_test'->>'by' AS by, meta->'gateway'->>'provider' AS gateway,
             COALESCE(meta->'mid'->>'name', meta->'mid'->>'vault_label') AS account
        FROM vendor_payin_orders
       WHERE vendor = 'KATANA' AND merchant_id = $1 AND livemode AND meta ? 'staff_test'
       ORDER BY created_at DESC LIMIT 10
    `, [scope.code]);
    return NextResponse.json({
      merchant_code: scope.code,
      limits: { max_amount: VERIFY_MAX_AMOUNT, max_orders: VERIFY_MAX_ORDERS },
      tests: tests.map((t) => ({ ...t, pay_link: `${base()}/pay/${t.id}`, terminal: KATANA_TERMINAL.has(t.status) })),
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const schema = z.object({
  amount: z.coerce.number().min(1).max(10_000),
  customer_phone: z.string().trim().regex(/^[6-9]\d{9}$/, "a 10-digit Indian mobile number").optional().or(z.literal("").transform(() => undefined)),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // Real money moves: the same people who run the go-live checklist.
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN"]);
  if ("response" in g) return g.response;
  const scope = await resolveMerchantScope((await params).id, g.session);
  if ("response" in scope) return scope.response;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    const issue = (e as z.ZodError).issues?.[0];
    return NextResponse.json({ error: issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "invalid request" }, { status: 400 });
  }

  try {
    // A banker with no flow selected has its orders routed as they always were: to its pay-in
    // gateway when a live one is connected. Naming INTENT there would be refused
    // (FLOW_NOT_SELECTED), so the test leaves the flow out, and only when that gateway is live.
    const unset = (await getEffectiveFlow(scope.code)).flow === "UNSET";
    if (unset) {
      const gw = await getGatewayMidStatus(scope.code).catch(() => ({ configured: false as const }));
      if (!gw.configured || !gw.connector || gw.env !== "PROD")
        return NextResponse.json({ error: "no live pay-in gateway is connected for this banker: save live credentials under Pay-in gateway first", code: "FLOW_NOT_READY" }, { status: 409 });
    }
    const r = await createKatanaOrder({
      orderId: `LT-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 4).toUpperCase()}`,
      amount: Math.round(body.amount * 100) / 100,
      currency: "INR",
      merchantId: scope.code,
      receiverVpas: [],
      mode: "INTENT",
      flow: unset ? null : "INTENT",   // never a UPI ID: a banker not on Intent is refused (FLOW_NOT_ENABLED)
      livemode: true,          // whatever the dashboard's Test / Live switch says
      customerPhone: body.customer_phone ?? null,
      client: intentClientFrom(req),
      staffTest: { by: g.session.email },
    });
    if (!r.order) return NextResponse.json({ error: "order create failed" }, { status: 500 });
    // Which account the MID switch put it on, for the person testing.
    const meta = (await rows<{ meta: any }>("vendorGateway",
      `SELECT meta FROM vendor_payin_orders WHERE id = $1::uuid`, [r.order.id]).catch(() => []))[0]?.meta ?? {};
    // With no flow selected the old routing decided; say so if it did not reach the gateway.
    const warning = r.order.channel_type !== "INTENT"
      ? "this order was not sent to the pay-in gateway (no flow is selected and the old routing chose a UPI ID); select Intent or Both for this banker"
      : null;
    return NextResponse.json({
      order: { id: r.order.id, order_id: r.order.order_id, amount: Number(r.order.amount), status: r.order.status, created_at: r.order.created_at },
      pay_link: `${base()}/pay/${r.order.id}`,
      gateway: meta.gateway?.provider ?? null,
      account: meta.mid?.name ?? meta.mid?.vault_label ?? null,
      warning,
    }, { status: 201 });
  } catch (err) {
    if (err instanceof MerchantBlockedError) return NextResponse.json({ error: err.message, code: err.code }, { status: 403 });
    if (err instanceof PayinLimitError) return NextResponse.json(payinLimitBody(err.breach), { status: err.status });
    if (err instanceof NoMidAvailableError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    if (err instanceof OrderRefTakenError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    if (err instanceof AccountNotLiveError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    if (err instanceof PayinFlowError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    // Staff: the gateway's own words.
    if (err instanceof PayuIntentError || err instanceof PayinSetupError) return NextResponse.json({ error: err.message }, { status: err.status });
    const a = activationErrorResponse(err);   // live mode not activated for this banker
    if (a) return NextResponse.json(a.body, { status: a.status });
    const e = pgError(err); return NextResponse.json(e.body, { status: e.status });
  }
}
