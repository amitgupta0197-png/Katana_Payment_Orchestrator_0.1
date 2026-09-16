// The merchant's payout gateway (money out) and its credentials.
//   GET  /api/merchants/[id]/payout-gateway             non-secret status + webhook URL
//   GET  /api/merchants/[id]/payout-gateway?balance=1   ...plus the live balance (gateways with a connector)
//   POST /api/merchants/[id]/payout-gateway             connect / rotate: { gateway, env, fields }
//   POST /api/merchants/[id]/payout-gateway?action=register-webhook
//        point the gateway's payout webhook at Katana, with a fresh shared token (PayU)
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
import {
  getPayuPayoutCreds, payoutWebhookUrl, payuPayoutBalance, registerPayuPayoutWebhook, storePayuPayoutCreds,
} from "@/lib/payu-payout";

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
    const webhook_url = payoutWebhookUrl();   // for "Copy endpoint"; not a secret
    if (new URL(req.url).searchParams.get("balance") !== "1") return NextResponse.json({ status, webhook_url });

    // Only a gateway with a payout connector can be asked; today that is PayU.
    const payu = await getPayuPayoutCreds(code);
    if (!payu) return NextResponse.json({ status, webhook_url, balance: { ok: false, error: "balance check isn't available for this gateway yet" } });
    const bal = await payuPayoutBalance(payu);
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
      const creds = await getPayuPayoutCreds(code);
      if (!creds) return NextResponse.json({ error: "webhook registration is only available for PayU payouts today" }, { status: 409 });
      const r = await registerPayuPayoutWebhook(creds);
      if (!r.ok) return NextResponse.json({ error: `PayU: ${r.error}` }, { status: 502 });
      // Stored only after PayU took it: until then the old token is still the one PayU sends.
      await storePayuPayoutCreds(code, { ...creds, webhook_token: r.data.token, webhook_registered_at: new Date().toISOString() });
      await audit("merchant.payout_gateway.webhook_registered", null, { merchant_code: code, gateway: "PAYU", url: r.data.url, env: creds.env });
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

    const prev = await getPayoutGateway(code);
    const before = await getPayoutGatewayStatus(code);
    // A registered webhook belongs to that gateway account, so it survives a secret rotation
    // but not a change of gateway, environment or payout account.
    const sameAccount = prev && prev.gateway === body.gateway && prev.env === body.env
      && (body.gateway !== "PAYU" || prev.fields.payout_merchant_id === v.values.payout_merchant_id);
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
