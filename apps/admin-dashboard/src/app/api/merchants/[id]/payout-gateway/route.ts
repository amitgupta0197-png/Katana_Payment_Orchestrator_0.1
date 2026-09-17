// The merchant's payout gateway (money out) and its credentials.
//   GET  /api/merchants/[id]/payout-gateway             non-secret status + webhook URL
//   GET  /api/merchants/[id]/payout-gateway?balance=1   ...plus the live balance (gateways with a balance API)
//   POST /api/merchants/[id]/payout-gateway             connect / rotate: { gateway, env, fields }
//   POST /api/merchants/[id]/payout-gateway?action=register-webhook
//        point the gateway's payout webhook at Katana by API (PayU; the others are set in their
//        own dashboards, or per transfer for Paytm)
//
// SUPER_ADMIN only: these are gateway secrets Katana holds for the merchant. One payout gateway
// per merchant; saving another replaces it. Changes are audited, never the secrets.
import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { wormAppend } from "@/lib/worm";
import { GATEWAYS, gatewayDef, validateCredFields, type GatewayId } from "@/lib/pg-catalog";
import { getPayoutGateway, getPayoutGatewayStatus, storePayoutGateway } from "@/lib/payout-gateway";
import { activePayoutProvider, payoutConnector, payoutWebhookUrlFor, prodEnabled } from "@/lib/payout-providers";

export const dynamic = "force-dynamic";

async function merchantCode(id: string): Promise<string | null> {
  const m = await rows<{ merchant_code: string }>("merchant", `SELECT merchant_code FROM merchants WHERE id = $1::uuid`, [id]);
  return m[0]?.merchant_code ?? null;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  try {
    const code = await merchantCode(id);
    if (!code) return NextResponse.json({ error: "merchant not found" }, { status: 404 });
    const status = await getPayoutGatewayStatus(code);
    // For "Copy endpoint"; not a secret.
    const webhook_url = payoutWebhookUrlFor(status.configured ? status.gateway : "PAYU");
    if (new URL(req.url).searchParams.get("balance") !== "1") return NextResponse.json({ status, webhook_url });

    const active = await activePayoutProvider(code);
    if (!active?.connector.balance)
      return NextResponse.json({ status, webhook_url, balance: { ok: false, error: `${active?.connector.name ?? "This gateway"} has no balance API; check the balance in its dashboard` } });
    const bal = await active.connector.balance(active.creds);
    return NextResponse.json({
      status, webhook_url,
      balance: bal.ok
        ? { ok: true, balance_minor: bal.data.balanceMinor.toString(), low_balance: bal.data.lowBalance }
        : { ok: false, error: bal.error },
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const payoutGateways = GATEWAYS.filter((x) => x.payout).map((x) => x.id);
const schema = z.object({
  gateway: z.enum(payoutGateways as [string, ...string[]]),
  env: z.enum(["TEST", "PROD"]).default("TEST"),
  fields: z.record(z.string()).default({}),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  const audit = (action: string, before: unknown, after: unknown) => wormAppend({
    actorId: g.session.user_id, actorEmail: g.session.email, action,
    resourceType: "merchant", resourceId: id, before, after,
  }).catch(() => {});
  try {
    const code = await merchantCode(id);
    if (!code) return NextResponse.json({ error: "merchant not found" }, { status: 404 });

    if (new URL(req.url).searchParams.get("action") === "register-webhook") {
      const active = await activePayoutProvider(code);
      if (!active?.connector.registerWebhook)
        return NextResponse.json({ error: `${active?.connector.name ?? "This gateway"}'s webhook is set in its own dashboard, not by API` }, { status: 409 });
      const r = await active.connector.registerWebhook(code, active.creds);
      if (!r.ok) return NextResponse.json({ error: `${active.connector.name}: ${r.error}` }, { status: 502 });
      await audit("merchant.payout_gateway.webhook_registered", null, { merchant_code: code, gateway: active.connector.id, url: r.data.url, env: active.creds.env });
      return NextResponse.json({ status: await getPayoutGatewayStatus(code), webhook_url: r.data.url });
    }

    let body;
    try { body = schema.parse(await req.json()); } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    }
    const svc = gatewayDef(body.gateway)!.payout!;
    const v = validateCredFields(svc, body.fields);
    if (!v.values) return NextResponse.json({ error: v.error }, { status: 400 });
    if (body.gateway === "RAZORPAY" && v.values.key_id.startsWith("rzp_live_") !== (body.env === "PROD"))
      return NextResponse.json({ error: "the Key ID's mode (rzp_test_ / rzp_live_) doesn't match the environment" }, { status: 400 });
    // Live keys for a gateway whose connector hasn't been proven end to end yet would sit
    // unusable (every payout refused); say so now rather than at the first payout.
    if (body.env === "PROD" && payoutConnector(body.gateway) && !prodEnabled(body.gateway as GatewayId))
      return NextResponse.json({ error: `live ${gatewayDef(body.gateway)!.name} payouts aren't switched on yet — connect its sandbox (TEST) account first` }, { status: 409 });

    const prev = await getPayoutGateway(code);
    const before = await getPayoutGatewayStatus(code);
    // A registered webhook belongs to that gateway account, so it survives a secret rotation
    // but not a change of gateway, environment or payout account.
    const sameAccount = prev && prev.gateway === body.gateway && prev.env === body.env
      && (body.gateway !== "PAYU" || prev.fields.payout_merchant_id === v.values.payout_merchant_id)
      && (body.gateway !== "RAZORPAY" || prev.fields.account_number === v.values.account_number);
    await storePayoutGateway(code, {
      gateway: body.gateway as GatewayId,
      env: body.env, fields: v.values,
      webhook_token: sameAccount ? prev!.webhook_token : undefined,
      webhook_registered_at: sameAccount ? prev!.webhook_registered_at : undefined,
    });
    const after = await getPayoutGatewayStatus(code);
    await audit(prev ? "merchant.payout_gateway.rotated" : "merchant.payout_gateway.set", before, { merchant_code: code, ...after });
    return NextResponse.json({ status: after }, { status: 201 });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
