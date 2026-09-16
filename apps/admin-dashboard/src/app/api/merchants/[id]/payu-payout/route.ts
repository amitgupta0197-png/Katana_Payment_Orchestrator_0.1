// PayU Payouts credentials for a merchant (money out from the merchant's own PayU account).
//   GET  /api/merchants/[id]/payu-payout             non-secret status
//   GET  /api/merchants/[id]/payu-payout?balance=1   ...plus the live PayU balance (proves the creds work)
//   POST /api/merchants/[id]/payu-payout             store / rotate Client ID + Secret + payout merchant ID
//   POST /api/merchants/[id]/payu-payout?action=register-webhook
//        point PayU's default payout webhook at Katana, with a fresh shared token
//
// SUPER_ADMIN only, like gateway-mid: these are PayU secrets Katana holds for the merchant.
import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import {
  getPayuPayoutCreds, getPayuPayoutStatus, payuPayoutBalance, registerPayuPayoutWebhook, storePayuPayoutCreds,
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
    const status = await getPayuPayoutStatus(code);
    if (!status.configured || new URL(req.url).searchParams.get("balance") !== "1") return NextResponse.json({ status });

    const bal = await payuPayoutBalance((await getPayuPayoutCreds(code))!);
    return NextResponse.json({
      status,
      balance: bal.ok
        ? { ok: true, balance_minor: bal.data.balanceMinor.toString(), low_balance: bal.data.lowBalance }
        : { ok: false, error: bal.error },
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const schema = z.object({
  client_id: z.string().trim().min(1).max(512),
  client_secret: z.string().trim().min(1).max(512),
  payout_merchant_id: z.string().trim().regex(/^\d{1,20}$/, "payout merchant ID is numeric"),
  env: z.enum(["TEST", "PROD"]).default("TEST"),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  try {
    const code = await merchantCode(id);
    if (!code) return NextResponse.json({ error: "merchant not found" }, { status: 404 });

    if (new URL(req.url).searchParams.get("action") === "register-webhook") {
      const creds = await getPayuPayoutCreds(code);
      if (!creds) return NextResponse.json({ error: "set the PayU payout credentials first" }, { status: 409 });
      const r = await registerPayuPayoutWebhook(creds);
      if (!r.ok) return NextResponse.json({ error: `PayU: ${r.error}` }, { status: 502 });
      // Stored only after PayU took it: until then the old token is still the one PayU sends.
      await storePayuPayoutCreds(code, { ...creds, webhook_token: r.data.token, webhook_registered_at: new Date().toISOString() });
      return NextResponse.json({ status: await getPayuPayoutStatus(code), webhook_url: r.data.url });
    }

    let body;
    try { body = schema.parse(await req.json()); } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    }
    const prev = await getPayuPayoutCreds(code);
    // The registered webhook belongs to the PayU account, so it survives a secret rotation
    // but not a switch to another account or environment.
    const sameAccount = prev && prev.payout_merchant_id === body.payout_merchant_id && prev.env === body.env;
    await storePayuPayoutCreds(code, {
      ...body,
      webhook_token: sameAccount ? prev.webhook_token : undefined,
      webhook_registered_at: sameAccount ? prev.webhook_registered_at : undefined,
    });
    return NextResponse.json({ status: await getPayuPayoutStatus(code) }, { status: 201 });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
