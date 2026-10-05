// Guided PayAtom setup for one banker (lib/payatom-setup, components/merchant/payatom-connect).
//
//   GET  /api/merchants/{id}/payatom   what PayAtom does for this banker now, and what it still needs
//   POST /api/merchants/{id}/payatom   { want: { p2p, intent }, env, latitude, longitude,
//                                        p2p?: { pid, secret, api_key, api_base },
//                                        intent?: { pid, secret, api_key, api_base }, replace_main? }
//
// A field left blank keeps what is saved for that product. Saving puts each PayAtom account where
// Katana's routing needs it (main account, or an extra account in the MID switch) so nobody has to
// set that up by hand. SUPER_ADMIN only, like every processor credential; no secret is ever echoed.

import { NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "crypto";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { wormAppend } from "@/lib/worm";
import { accountVaultLabel, getGatewayMid, storeGatewayMid, type GatewayMid } from "@/lib/gateway-creds";
import { gatewayAccountChannel, gatewayDef, hint, validateCredFields } from "@/lib/pg-catalog";
import { payinProdEnabled, payinWebhookUrl } from "@/lib/payin-providers/types";
import { getGoLive, startVerifying } from "@/lib/gateway-golive";
import { addMid, bankerGatewayAccounts, getSettings, listMids, saveSettings } from "@/lib/mid-switch-store";
import { getEffectiveFlow } from "@/lib/payin-flow-store";
import { MAIN, payatomNow, planPayatom, type AccountNow, type PayatomProduct } from "@/lib/payatom-setup";

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

async function intentInSwitch(code: string, label: string | undefined): Promise<{ inSwitch: boolean; switchOn: boolean }> {
  if (!label) return { inSwitch: false, switchOn: false };
  const [mids, s] = await Promise.all([listMids(code, "GATEWAY").catch(() => []), getSettings(code, "GATEWAY").catch(() => null)]);
  return { inSwitch: mids.some((m) => m.vault_label === label && m.status === "ACTIVE") && !!s?.enabled, switchOn: !!s?.enabled };
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  try {
    const code = await bankerCode((await params).id);
    if (!code) return NextResponse.json({ error: "banker not found" }, { status: 404 });
    const accounts = await accountsOf(code);
    const intentAcc = accounts.find((a) => a.vault_label !== MAIN && a.gateway === "PAYATOM" && a.channel === "INTENT");
    const sw = await intentInSwitch(code, intentAcc?.vault_label);
    const now = payatomNow(accounts, sw.inSwitch);
    const flow = await getEffectiveFlow(code);
    const view = async (a: (typeof accounts)[number] | undefined | null) => a && {
      account: a.vault_label === MAIN ? "main" : "extra", env: a.mid.env ?? "TEST",
      pid_hint: hint(a.mid.key), api_base: a.mid.extra?.api_base ?? null,
      golive: (a.mid.env === "PROD" ? (await getGoLive(code, "PAYATOM", a.vault_label).catch(() => null))?.status : null) ?? null,
    };
    const byLabel = (x: AccountNow | null) => (x ? accounts.find((a) => a.vault_label === x.vault_label) : null);
    const main = accounts.find((a) => a.vault_label === MAIN);
    const anyPayatom = accounts.find((a) => a.gateway === "PAYATOM");
    return NextResponse.json({
      banker: code,
      flow: { flow: flow.flow, active: flow.active },
      p2p: await view(byLabel(now.p2p)),
      intent: now.intent ? { ...(await view(byLabel(now.intent))), reachable: now.intentReachable } : null,
      // Something other than PayAtom in the main account (shown, so replacing it is a decision).
      main_other: main && main.gateway !== "PAYATOM" ? { gateway: gatewayDef(main.gateway)?.name ?? main.gateway } : null,
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
  want: z.object({ p2p: z.boolean(), intent: z.boolean() }),
  env: z.enum(["PROD", "TEST"]),
  latitude: z.string().max(20),
  longitude: z.string().max(20),
  p2p: creds.optional(),
  intent: creds.optional(),
  replace_main: z.boolean().optional(),
}).strict();

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const p = schema.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({ error: p.error.issues[0].message }, { status: 400 });
  const b = p.data;
  const id = (await params).id;
  try {
    const code = await bankerCode(id);
    if (!code) return NextResponse.json({ error: "banker not found" }, { status: 404 });
    if (b.env === "PROD" && !payinProdEnabled("PAYATOM"))
      return NextResponse.json({ error: "live PayAtom payments are not switched on on the server yet: PAYATOM must be added to PAYIN_CONNECTORS_PROD", code: "LIVE_NOT_SWITCHED_ON" }, { status: 409 });

    const accounts = await accountsOf(code);
    // The planner gets accounts without their credentials, so nothing it returns can carry one.
    const planned = planPayatom(accounts.map(({ vault_label, gateway, channel }) => ({ vault_label, gateway, channel })), b.want, b.replace_main === true);
    if (!planned.ok) return NextResponse.json({ error: planned.error, code: planned.code, replaces: bare(planned.replaces) }, { status: 409 });
    const plan = planned.plan;

    // What is saved now for a product, wherever it is: a blank field keeps it.
    const savedFor = (product: PayatomProduct) => accounts.find((a) => a.gateway === "PAYATOM" && a.channel === product)?.mid ?? null;
    const def = gatewayDef("PAYATOM")!;
    const build = (product: PayatomProduct, c: z.infer<typeof creds> | undefined): GatewayMid | { error: string } => {
      const was = savedFor(product);
      const pick = (v: string | undefined, old: string | undefined) => (v?.trim() ? v.trim() : old ?? "");
      const fields = {
        channel: product,
        key: pick(c?.pid, was?.key), salt: pick(c?.secret, was?.salt),
        // Intent left blank: what is saved for Intent, else the P2P values of this same request
        // (PayAtom usually gives one API key and base URL for both products).
        api_key: pick(c?.api_key, was?.extra?.api_key ?? (product === "INTENT" ? b.p2p?.api_key?.trim() || undefined : undefined)),
        api_base: pick(c?.api_base, was?.extra?.api_base ?? (product === "INTENT" ? b.p2p?.api_base?.trim() || undefined : undefined)),
        latitude: b.latitude.trim(), longitude: b.longitude.trim(),
      };
      const v = validateCredFields(def.payin, fields);
      if (!v.values) return { error: `${product === "P2P" ? "UPI link (P2P)" : "Intent"}: ${v.error}` };
      const f = v.values;
      return {
        gateway: "PAYATOM", mid_code: f.key, key: f.key, salt: f.salt, scheme: "HMAC_SHA256", env: b.env,
        extra: { channel: product, api_key: f.api_key, api_base: f.api_base, latitude: f.latitude, longitude: f.longitude },
      };
    };
    const p2pMid = plan.p2p ? build("P2P", b.p2p) : null;
    const intentMid = plan.intent ? build("INTENT", b.intent) : null;
    for (const m of [p2pMid, intentMid]) if (m && "error" in m) return NextResponse.json({ error: m.error }, { status: 400 });

    const by = g.session.email;
    const saved: { product: PayatomProduct; label: string; golive: string | null }[] = [];
    const save = async (product: PayatomProduct, mid: GatewayMid, label: string) => {
      const before = await getGatewayMid(code, label).catch(() => null);
      await storeGatewayMid(code, mid, label);
      let golive: string | null = null;
      if (mid.env === "PROD") {
        // Rotating a live account of the same product keeps it live; anything else is verified first.
        const alreadyLive = !!before && before.gateway === "PAYATOM" && before.env === "PROD" && gatewayAccountChannel(before) === product;
        golive = (await startVerifying(code, "PAYATOM", by, alreadyLive, label).catch(() => null))?.status ?? null;
      }
      saved.push({ product, label, golive });
    };
    // Intent first: when both are chosen and PayAtom Intent sat in the main account, it moves out
    // before the main account takes P2P.
    if (plan.intent && intentMid && !("error" in intentMid)) {
      const label = plan.intent.label === "new" ? accountVaultLabel(randomUUID()) : plan.intent.label;
      await save("INTENT", intentMid, label);
      if (plan.intent.addToSwitch) {
        const inSwitch = (await listMids(code, "GATEWAY")).some((m) => m.vault_label === label);
        if (!inSwitch) await addMid({ banker: code, kind: "GATEWAY", vault_label: label, name: "PayAtom Intent" }, `katana:${by}`);
        await saveSettings(code, "GATEWAY", { enabled: true }, `katana:${by}`);
      }
    }
    if (plan.p2p && p2pMid && !("error" in p2pMid)) await save("P2P", p2pMid, plan.p2p.label);

    await wormAppend({
      actorId: g.session.user_id, actorEmail: by, action: "merchant.payatom.setup",
      resourceType: "merchant", resourceId: id,
      before: { replaces: bare(plan.replaces) },
      after: { merchant_code: code, env: b.env, want: b.want, accounts: saved.map((s) => ({ product: s.product, account: s.label })) },
    }).catch(() => {});
    return NextResponse.json({ saved, replaced: bare(plan.replaces) }, { status: 201 });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
