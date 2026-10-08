// Pay-in gateway credentials for a merchant (internal mapping).
//   GET  /api/merchants/[id]/gateway-mid   — non-secret status (no secrets).
//   POST /api/merchants/[id]/gateway-mid   — connect / rotate the merchant's pay-in gateway.
//        body: { gateway, env, auth?, fields: { … per lib/pg-catalog … } }
//        auth: a sign-in mode from the gateway's altAuth (PayU: "client_credentials"); default otherwise.
//
// SUPER_ADMIN only: these are the gateway's secrets, which Katana holds on the merchant's
// behalf and never exposes. Stored sealed in the credential vault. Changes are audited (never
// the secrets).
//
// `account` picks which of the banker's processor accounts is saved: left out, its first one
// (as before: saving replaces it); "new" adds another for the MID switch (lib/mid-switch); a
// vault label from `accounts` rotates that one. GET lists every account (`accounts`).
//
// A banker that needs host-to-host (its own merchants.needs_h2h, else its merchant's providers.needs_h2h;
// lib/checkout-mode-store) may
// not be given a redirect-only Intent account: 409 H2H_REQUIRED, unless `override_h2h: true`
// comes with a `note` of 5+ characters (recorded). GET says the banker's need and each
// account's checkout mode (lib/pg-catalog gatewayCheckoutMode).

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { wormAppend } from "@/lib/worm";
import { randomUUID } from "crypto";
import { storeGatewayMid, getGatewayMid, getGatewayMidStatus, payinProdId, accountVaultLabel, VAULT_LABEL } from "@/lib/gateway-creds";
import { bankerGatewayAccounts } from "@/lib/mid-switch-store";
import { GATEWAYS, gatewayAccountChannel, gatewayCheckoutMode, gatewayDef, validateCredFields } from "@/lib/pg-catalog";
import { bankerNeedsH2h } from "@/lib/checkout-mode-store";
import { payinProdEnabled, payinWebhookUrl } from "@/lib/payin-providers/types";
import { getGoLive, startVerifying } from "@/lib/gateway-golive";

export const dynamic = "force-dynamic";

async function merchantCode(id: string): Promise<string | null> {
  const m = await rows<{ merchant_code: string }>("merchant", `SELECT merchant_code FROM merchants WHERE id = $1::uuid`, [id]);
  return m[0]?.merchant_code ?? null;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  const code = await merchantCode(id);
  if (!code) return NextResponse.json({ error: "merchant not found" }, { status: 404 });
  try {
    const status = await getGatewayMidStatus(code);
    // Where the gateway should send payment events; not a secret.
    // PayU Client ID mode has no webhook: its payments are confirmed from the Payment Links API.
    const hook = status.configured && !(status.gateway === "PAYU" && status.auth === "client_credentials");
    // Where a live account stands on the go-live checklist; null for one with no checklist.
    const golive = status.configured && status.env === "PROD" ? await getGoLive(code, status.gateway).catch(() => null) : null;
    // Every processor account, each with where it stands on its own go-live checklist.
    // Each account's checkout mode: host-to-host or redirect (an account on the P2P flow is H2H).
    const modeOf = (mid: { gateway: string; auth?: string | null; extra?: Record<string, string> } | null) =>
      !mid ? null : gatewayAccountChannel(mid) === "P2P" ? "H2H" : gatewayCheckoutMode(mid.gateway, mid.auth ?? null);
    const accounts = await Promise.all((await bankerGatewayAccounts(code).catch(() => [])).map(async (a) => ({
      ...a, golive: a.env === "PROD" ? (await getGoLive(code, a.gateway, a.vault_label).catch(() => null))?.status ?? null : null,
      checkout: modeOf(await getGatewayMid(code, a.vault_label).catch(() => null)),
    })));
    return NextResponse.json({
      status, webhook_url: hook ? payinWebhookUrl(status.gateway as never) : null, golive: golive ? { status: golive.status } : null, accounts,
      checkout: status.configured ? modeOf(await getGatewayMid(code).catch(() => null)) : null,
      needs_h2h: await bankerNeedsH2h(code),
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const schema = z.object({
  gateway: z.enum(GATEWAYS.map((x) => x.id) as [string, ...string[]]),
  env: z.enum(["TEST", "PROD"]).default("TEST"),
  auth: z.enum(["key_salt", "client_credentials"]).optional(),
  fields: z.record(z.string()).default({}),
  account: z.string().max(80).optional(),
  override_h2h: z.boolean().optional(),
  note: z.string().max(500).optional(),
});

// The built-in fields every gateway maps onto; everything else is kept as an extra.
const CORE = new Set(["mid_code", "key", "salt"]);

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  const code = await merchantCode(id);
  if (!code) return NextResponse.json({ error: "merchant not found" }, { status: 404 });

  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  const def = gatewayDef(body.gateway)!;
  const alt = body.auth && body.auth !== "key_salt" ? def.payin.altAuth?.find((m) => m.id === body.auth) : undefined;
  if (body.auth && body.auth !== "key_salt" && !alt)
    return NextResponse.json({ error: `${def.name} pay-ins don't support that sign-in` }, { status: 400 });
  const v = validateCredFields(def.payin, body.fields, alt?.id);
  if (!v.values) return NextResponse.json({ error: v.error }, { status: 400 });
  const f = v.values;
  // Razorpay keys say which mode they belong to; don't let a live key be saved as test.
  if (def.id === "RAZORPAY" && f.key.startsWith("rzp_live_") !== (body.env === "PROD"))
    return NextResponse.json({ error: "the Key ID's mode (rzp_test_ / rzp_live_) doesn't match the environment" }, { status: 400 });

  // Live keys for a gateway whose connector hasn't been proven end to end would sit unusable
  // (every live order refused); say so now rather than at the first payment.
  if (body.env === "PROD" && !payinProdEnabled(payinProdId({ gateway: def.id, auth: alt?.id })))
    return NextResponse.json({ error: `live ${def.name}${alt ? ` (${alt.label})` : ""} payments aren't switched on yet — connect its sandbox (TEST) account first` }, { status: 409 });

  const extra = Object.fromEntries(Object.entries(f).filter(([k]) => !CORE.has(k)));
  // A merchant that needs host-to-host gets no redirect-only Intent account, unless overridden.
  const mode = gatewayAccountChannel({ gateway: def.id, extra }) === "P2P" ? "H2H" : gatewayCheckoutMode(def.id, alt?.id ?? null);
  const h2hOverride = mode === "REDIRECT" && await bankerNeedsH2h(code);
  if (h2hOverride) {
    if (!body.override_h2h)
      return NextResponse.json({
        error: `${code} needs host-to-host checkout, and ${def.name}${alt ? ` (${alt.label})` : ""} only offers a redirect to its own payment page. Choose a host-to-host gateway, or save anyway with a note.`,
        code: "H2H_REQUIRED",
      }, { status: 409 });
    if ((body.note ?? "").trim().length < 5)
      return NextResponse.json({ error: "saving a redirect-only account anyway needs a note saying why", code: "OVERRIDE_NOTE_REQUIRED" }, { status: 400 });
  }
  // Which account: the first (default), a new one, or an existing one by its label.
  let label = VAULT_LABEL;
  if (body.account === "new") label = accountVaultLabel(randomUUID());
  else if (body.account && body.account !== VAULT_LABEL) {
    if (!(await bankerGatewayAccounts(code)).some((a) => a.vault_label === body.account))
      return NextResponse.json({ error: "no such processor account on this banker" }, { status: 404 });
    label = body.account;
  }
  try {
    const before = await getGatewayMidStatus(code, label);
    await storeGatewayMid(code, {
      gateway: def.id,
      mid_code: f.mid_code ?? f.key,
      key: f.key, salt: f.salt,
      // PayU signs with its SHA-512 hash; the others get their own signing in their connector.
      scheme: def.id === "PAYU" ? "PAYU_SHA512" : "HMAC_SHA256",
      env: body.env,
      ...(alt ? { auth: alt.id } : {}),
      extra: Object.keys(extra).length ? extra : undefined,
    }, label);
    const after = await getGatewayMidStatus(code, label);
    // A live account goes on the go-live checklist (lib/gateway-golive) and takes only small
    // verification payments until it passes. One that was already live on this gateway is
    // recorded as LIVE: rotating its credentials must not stop its payments. Each account has its
    // own checklist (vendorGateway 0041): a second account on the same gateway starts VERIFYING.
    let golive = null;
    if (body.env === "PROD") {
      const alreadyLive = before.configured && before.env === "PROD" && before.gateway === def.id;
      golive = await startVerifying(code, def.id, g.session.email, alreadyLive, label).catch(() => null);
    }
    await wormAppend({
      actorId: g.session.user_id, actorEmail: g.session.email,
      action: before.configured ? "merchant.payin_gateway.rotated" : "merchant.payin_gateway.set",
      resourceType: "merchant", resourceId: id, before, after: { merchant_code: code, account: label, ...after },
    }).catch(() => {});
    if (h2hOverride)
      await wormAppend({
        actorId: g.session.user_id, actorEmail: g.session.email, action: "merchant.payin_gateway.h2h_override",
        resourceType: "merchant", resourceId: id, after: { merchant_code: code, account: label, gateway: def.id, checkout: "REDIRECT" }, notes: body.note,
      }).catch(() => {});
    // Echo only non-secret status back.
    return NextResponse.json({ status: after, account: label, golive: golive ? { status: golive.status } : null }, { status: 201 });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
