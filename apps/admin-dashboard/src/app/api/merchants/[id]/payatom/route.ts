// Guided PayAtom setup for one banker (lib/payatom-setup, components/merchant/payatom-connect).
//
//   GET  /api/merchants/{id}/payatom   what PayAtom does for this banker now, and what it still needs
//   POST /api/merchants/{id}/payatom   { env, latitude, longitude, p2p?: { pid, secret, api_key, api_base },
//                                        replace_main? }
//
// PayAtom is used for P2P only (lib/payatom-setup): saving puts PayAtom P2P in the banker's main
// account. `want.intent: true` is refused (INTENT_NOT_OFFERED). A field left blank keeps what is
// saved. SUPER_ADMIN only, like every processor credential; no secret is ever echoed.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { wormAppend } from "@/lib/worm";
import { getGatewayMid, storeGatewayMid, type GatewayMid } from "@/lib/gateway-creds";
import { gatewayAccountChannel, gatewayDef, hint, validateCredFields } from "@/lib/pg-catalog";
import { payinProdEnabled, payinWebhookUrl } from "@/lib/payin-providers/types";
import { getGoLive, startVerifying } from "@/lib/gateway-golive";
import { bankerGatewayAccounts } from "@/lib/mid-switch-store";
import { getEffectiveFlow } from "@/lib/payin-flow-store";
import { MAIN, payatomNow, planPayatom, type AccountNow } from "@/lib/payatom-setup";

export const dynamic = "force-dynamic";

/** The address PayAtom must whitelist: Katana's server. */
const SERVER_IP = process.env.KATANA_SERVER_IP ?? "72.61.227.233";

/** An account as it may be shown or logged: never its credentials. */
const bare = (a: AccountNow | null | undefined) => (a ? { account: a.vault_label === MAIN ? "main" : "extra", gateway: a.gateway, channel: a.channel } : null);

async function bankerCode(id: string): Promise<string | null> {
  const m = await rows<{ merchant_code: string }>("merchant", `SELECT merchant_code FROM merchants WHERE id = $1::uuid`, [id]);
  return m[0]?.merchant_code ?? null;
}

/** Every processor account of the banker, with its gateway, product and the saved credentials. */
async function accountsOf(code: string): Promise<(AccountNow & { mid: GatewayMid })[]> {
  const list = await bankerGatewayAccounts(code).catch(() => []);
  const out: (AccountNow & { mid: GatewayMid })[] = [];
  for (const a of list) {
    const mid = await getGatewayMid(code, a.vault_label).catch(() => null);
    if (mid) out.push({ vault_label: a.vault_label, gateway: mid.gateway, channel: gatewayAccountChannel(mid), mid });
  }
  return out;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  try {
    const code = await bankerCode((await params).id);
    if (!code) return NextResponse.json({ error: "banker not found" }, { status: 404 });
    const accounts = await accountsOf(code);
    const now = payatomNow(accounts);
    const flow = await getEffectiveFlow(code);
    const view = async (a: (typeof accounts)[number] | undefined | null) => a && {
      account: a.vault_label === MAIN ? "main" : "extra", env: a.mid.env ?? "TEST",
      pid_hint: hint(a.mid.key), api_key_hint: hint(a.mid.extra?.api_key), api_base: a.mid.extra?.api_base ?? null,
      // Shown as a warning: the saved API key is the secret key (a paste slip).
      api_key_is_secret: !!a.mid.extra?.api_key && a.mid.extra.api_key === a.mid.salt,
      golive: (a.mid.env === "PROD" ? (await getGoLive(code, "PAYATOM", a.vault_label).catch(() => null))?.status : null) ?? null,
    };
    const byLabel = (x: AccountNow | null) => (x ? accounts.find((a) => a.vault_label === x.vault_label) : null);
    const main = accounts.find((a) => a.vault_label === MAIN);
    const anyPayatom = accounts.find((a) => a.gateway === "PAYATOM");
    return NextResponse.json({
      banker: code,
      flow: { flow: flow.flow, active: flow.active },
      p2p: await view(byLabel(now.p2p)),
      // A PayAtom Intent account saved before Katana stopped using PayAtom for Intent: takes no orders.
      retired_intent: now.retiredIntent ? { account: now.retiredIntent.vault_label === MAIN ? "main" : "extra" } : null,
      // Something other than PayAtom P2P in the main account (shown, so replacing it is a decision).
      main_other: main && !(main.gateway === "PAYATOM" && main.channel === "P2P")
        ? { gateway: main.gateway === "PAYATOM" ? "PayAtom Intent (no longer used)" : gatewayDef(main.gateway)?.name ?? main.gateway } : null,
      location: anyPayatom ? { latitude: anyPayatom.mid.extra?.latitude ?? "", longitude: anyPayatom.mid.extra?.longitude ?? "" } : null,
      live_switched_on: payinProdEnabled("PAYATOM"),
      payatom_needs: { whitelist_ip: SERVER_IP, callback_url: payinWebhookUrl("PAYATOM") },
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const creds = z.object({
  pid: z.string().max(200).optional(), secret: z.string().max(500).optional(),
  api_key: z.string().max(500).optional(), api_base: z.string().max(300).optional(),
}).strict();
const schema = z.object({
  // Older callers send what PayAtom should do; only P2P is offered.
  want: z.object({ p2p: z.boolean(), intent: z.boolean() }).optional(),
  env: z.enum(["PROD", "TEST"]),
  latitude: z.string().max(20),
  longitude: z.string().max(20),
  p2p: creds.optional(),
  replace_main: z.boolean().optional(),
}).strict();

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const p = schema.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({ error: p.error.issues[0].message }, { status: 400 });
  const b = p.data;
  if (b.want?.intent) return NextResponse.json({ error: "PayAtom is used for P2P only; connect another gateway for Intent", code: "INTENT_NOT_OFFERED" }, { status: 400 });
  const id = (await params).id;
  try {
    const code = await bankerCode(id);
    if (!code) return NextResponse.json({ error: "banker not found" }, { status: 404 });
    if (b.env === "PROD" && !payinProdEnabled("PAYATOM"))
      return NextResponse.json({ error: "live PayAtom payments are not switched on on the server yet: PAYATOM must be added to PAYIN_CONNECTORS_PROD", code: "LIVE_NOT_SWITCHED_ON" }, { status: 409 });

    const accounts = await accountsOf(code);
    // The planner gets accounts without their credentials, so nothing it returns can carry one.
    const planned = planPayatom(accounts.map(({ vault_label, gateway, channel }) => ({ vault_label, gateway, channel })), b.replace_main === true);
    if (!planned.ok) return NextResponse.json({ error: planned.error, code: planned.code, replaces: bare(planned.replaces) }, { status: 409 });
    const plan = planned.plan;

    // What is saved now for P2P: a blank field keeps it.
    const was = accounts.find((a) => a.gateway === "PAYATOM" && a.channel === "P2P")?.mid ?? null;
    const pick = (v: string | undefined, old: string | undefined) => (v?.trim() ? v.trim() : old ?? "");
    const v = validateCredFields(gatewayDef("PAYATOM")!.payin, {
      channel: "P2P",
      key: pick(b.p2p?.pid, was?.key), salt: pick(b.p2p?.secret, was?.salt),
      api_key: pick(b.p2p?.api_key, was?.extra?.api_key), api_base: pick(b.p2p?.api_base, was?.extra?.api_base),
      latitude: b.latitude.trim(), longitude: b.longitude.trim(),
    });
    if (!v.values) return NextResponse.json({ error: v.error }, { status: 400 });
    const f = v.values;
    // The API key and the secret key are two different values from PayAtom. The same value in
    // both boxes is a paste slip, and PayAtom answers every request "Invalid API key".
    if (f.api_key === f.salt)
      return NextResponse.json({ error: "the API key is the same as the secret key. Paste PayAtom's API key (X-Api-Key) in the API key box." }, { status: 400 });
    const mid: GatewayMid = {
      gateway: "PAYATOM", mid_code: f.key, key: f.key, salt: f.salt, scheme: "HMAC_SHA256", env: b.env,
      extra: { channel: "P2P", api_key: f.api_key, api_base: f.api_base, latitude: f.latitude, longitude: f.longitude },
    };

    const by = g.session.email;
    const label = plan.p2p.label;
    const before = await getGatewayMid(code, label).catch(() => null);
    await storeGatewayMid(code, mid, label);
    let golive: string | null = null;
    if (mid.env === "PROD") {
      // Rotating a live PayAtom P2P account keeps it live; anything else is verified first.
      const alreadyLive = !!before && before.gateway === "PAYATOM" && before.env === "PROD" && gatewayAccountChannel(before) === "P2P";
      golive = (await startVerifying(code, "PAYATOM", by, alreadyLive, label).catch(() => null))?.status ?? null;
    }
    const saved = [{ product: "P2P" as const, label, golive }];

    await wormAppend({
      actorId: g.session.user_id, actorEmail: by, action: "merchant.payatom.setup",
      resourceType: "merchant", resourceId: id,
      before: { replaces: bare(plan.replaces) },
      after: { merchant_code: code, env: b.env, accounts: saved.map((s) => ({ product: s.product, account: s.label })) },
    }).catch(() => {});
    return NextResponse.json({ saved, replaced: bare(plan.replaces) }, { status: 201 });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
