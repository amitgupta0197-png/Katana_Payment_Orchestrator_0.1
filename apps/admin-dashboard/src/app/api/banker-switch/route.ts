// The banker switch (lib/banker-switch): a merchant's pay-in traffic between its own bankers.
//
//   GET  /api/banker-switch                      the signed-in merchant's switch
//   GET  /api/banker-switch?banker=CODE          staff: the switch of that banker's merchant
//   GET  /api/banker-switch?provider=ID          staff: that merchant's switch
//   POST /api/banker-switch                      { provider?, action, … }
//        settings  { enabled?, mode? }                on / off, PRIORITY or WEIGHTED
//        member    { banker, in_rotation?, priority?, weight? }
//        pin       { banker, minutes?, reason? }      every order to this banker; unpin {}
//
// Staff see every merchant (SUPER_ADMIN, ADMIN and OPERATOR change it); a merchant (PROVIDER) its
// own. A banker login is not given its merchant's other bankers. Each banker is shown with its Key;
// staff also see the first characters of its Salt. Nobody is shown the Salt itself.

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { STAFF_PERSONAS } from "@/lib/portal-scope";
import { seesGatewayNames, stripGatewayNames } from "@/lib/merchant-safe";
import { providerForMerchant } from "@/lib/provider-integration";
import { getCheckoutCredsStatus } from "@/lib/merchant-checkout";
import { isLiveActivated } from "@/lib/live-activation";
import { actorWords } from "@/lib/mid-switch-view";
import { activePin, BANKER_SWITCH_MODES, bankerOrder, passOverWords } from "@/lib/banker-switch";
import {
  bankerToday, getMembers, getSwitchSettings, listSwitchEvents, pinBanker, providerBankers, saveMember, saveSwitchSettings,
} from "@/lib/banker-switch-store";

export const dynamic = "force-dynamic";

const WRITERS = new Set(["SUPER_ADMIN", "ADMIN", "OPERATOR", "PROVIDER"]);
const notFound = () => NextResponse.json({ error: "not found" }, { status: 404 });

/** The merchant this request is about: a merchant login's own; staff name one (or one of its bankers). */
async function providerOf(s: { persona: string; scope_id?: string | null }, url: URL): Promise<string | null> {
  if (s.persona === "PROVIDER") return s.scope_id ?? null;
  const p = url.searchParams.get("provider")?.trim();
  if (p) return p;
  const b = url.searchParams.get("banker")?.trim();
  return b ? providerForMerchant(b) : null;
}

export async function GET(req: Request) {
  const g = await gateOrResponse([...STAFF_PERSONAS, "PROVIDER"]);
  if ("response" in g) return g.response;
  try {
    const providerId = await providerOf(g.session, new URL(req.url));
    if (!providerId) return notFound();
    return NextResponse.json(await detail(providerId, seesGatewayNames(g.session.persona), WRITERS.has(g.session.persona)));
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

async function detail(providerId: string, staff: boolean, canChange: boolean) {
  const now = new Date();
  const bankers = await providerBankers(providerId);
  const codes = bankers.map((b) => b.code);
  const [settings, members, today, events, keys, live] = await Promise.all([
    getSwitchSettings(providerId), getMembers(providerId, codes), bankerToday(codes, true), listSwitchEvents(providerId),
    Promise.all(codes.map(async (c) => [c, await getCheckoutCredsStatus(c, true), await getCheckoutCredsStatus(c, false)] as const)),
    Promise.all(codes.map(async (c) => [c, await isLiveActivated(c).catch(() => false)] as const)),
  ]);
  const pin = activePin(settings, codes, now);
  // The order the next live order would be offered in (WEIGHTED: one draw of it, as an example).
  const next = bankerOrder(members, settings, now, { ordersToday: Object.fromEntries(Object.entries(today).map(([b, t]) => [b, t.orders])) });
  const nameOf = (c: string | null) => (c ? bankers.find((b) => b.code === c)?.name ?? c : null);
  // A note typed by staff may name a processor; a merchant is never shown one (lib/merchant-safe).
  const safe = (t: string | null) => (t == null ? null : staff ? t : stripGatewayNames(t, "processor"));
  return {
    provider_id: providerId, staff, can_change: canChange,
    settings: { ...settings, pinned_banker: pin, pinned_until: pin ? settings.pinned_until : null, pin_reason: pin ? safe(settings.pin_reason) : null },
    modes: BANKER_SWITCH_MODES,
    next_order: settings.enabled ? next.map((c) => c.banker) : [],
    bankers: bankers.map((b) => {
      const m = members.find((x) => x.banker_code === b.code)!;
      const k = keys.find((x) => x[0] === b.code)!;
      const liveOn = live.find((x) => x[0] === b.code)?.[1] ?? false;
      // A merchant is shown the Key, never anything of the Salt (lib/key-access).
      const liveKey = k[1].configured ? { key: k[1].key, salt_hint: staff ? k[1].salt_hint : null } : null;
      const testKey = k[2].configured ? { key: k[2].key, salt_hint: staff ? k[2].salt_hint : null } : null;
      const notReady = [!liveKey && "NO_KEY", !liveOn && "LIVE_MODE_NOT_ACTIVATED"].filter(Boolean) as string[];
      return {
        banker: b.code, name: b.name,
        in_rotation: m.in_rotation, priority: m.priority, weight: m.weight,
        live_key: liveKey, test_key: testKey,
        live_ready: notReady.length === 0, not_ready: notReady.map(passOverWords),
        today: today[b.code] ?? { orders: 0, amount: 0, paid: 0 },
        pinned: pin === b.code, in_use: settings.last_banker === b.code,
      };
    }),
    events: events.map((e) => ({
      at: e.at, action: e.action, banker: e.banker_code, banker_name: nameOf(e.banker_code),
      who: actorWords(e.actor, staff), text: safe(eventText(e, nameOf)),
    })),
  };
}

function eventText(e: { action: string; banker_code: string | null; detail: Record<string, unknown> }, nameOf: (c: string | null) => string | null): string {
  const d = e.detail ?? {};
  const name = nameOf(e.banker_code);
  const passed = Array.isArray(d.passed_over) ? (d.passed_over as { banker: string; code: string }[]) : [];
  const passedText = passed.map((p) => `${nameOf(p.banker)} ${passOverWords(p.code)}`).join("; ");
  switch (e.action) {
    case "SETTINGS": return [d.enabled === true ? "Switch on" : d.enabled === false ? "Switch off" : null, d.mode ? `mode ${d.mode}` : null].filter(Boolean).join(", ") || "Settings changed";
    case "MEMBER": return `${name}: ${[d.in_rotation === true ? "in rotation" : d.in_rotation === false ? "out of rotation" : null,
      d.priority != null ? `priority ${d.priority}` : null, d.weight != null ? `weight ${d.weight}` : null].filter(Boolean).join(", ")}`;
    case "PINNED": return `All orders to ${name}${d.minutes ? ` for ${d.minutes} min` : ""}${d.reason ? ` (${d.reason})` : ""}`;
    case "UNPINNED": return "Back to automatic";
    case "AUTO_SWITCH": return `Orders now going to ${name}${d.from ? ` (was ${nameOf(String(d.from))})` : ""}${passedText ? `: ${passedText}` : ""}`;
    case "PASSED_OVER": return `Order ${d.txnid ?? ""} went to ${name}: ${passedText}`;
    case "NONE_AVAILABLE": return `No banker could take order ${d.txnid ?? ""}: ${passedText}`;
    default: return e.action;
  }
}

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("settings"), provider: z.string().optional(), enabled: z.boolean().optional(), mode: z.enum(BANKER_SWITCH_MODES).optional() }),
  z.object({ action: z.literal("member"), provider: z.string().optional(), banker: z.string().min(1),
    in_rotation: z.boolean().optional(), priority: z.coerce.number().int().min(1).max(99).optional(), weight: z.coerce.number().int().min(0).max(100).optional() }),
  z.object({ action: z.literal("pin"), provider: z.string().optional(), banker: z.string().min(1),
    minutes: z.coerce.number().int().min(5).max(7 * 24 * 60).nullish(), reason: z.string().trim().max(200).optional() }),
  z.object({ action: z.literal("unpin"), provider: z.string().optional() }),
]);

export async function POST(req: Request) {
  const g = await gateOrResponse([...STAFF_PERSONAS, "PROVIDER"]);
  if ("response" in g) return g.response;
  const s = g.session;
  if (!WRITERS.has(s.persona)) return NextResponse.json({ error: "your role cannot change the banker switch" }, { status: 403 });
  let b: z.infer<typeof body>;
  try { b = body.parse(await req.json()); } catch (e) {
    const msg = e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : "invalid JSON";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
  try {
    const providerId = s.persona === "PROVIDER" ? s.scope_id ?? null : b.provider ?? null;
    if (!providerId) return notFound();
    const codes = (await providerBankers(providerId)).map((x) => x.code);
    if ("banker" in b && !codes.includes(b.banker)) return notFound();
    const staff = seesGatewayNames(s.persona);
    const actor = staff ? `katana:${s.email}` : s.email;
    switch (b.action) {
      case "settings": await saveSwitchSettings(providerId, { enabled: b.enabled, mode: b.mode }, actor); break;
      case "member": await saveMember(providerId, b.banker, { in_rotation: b.in_rotation, priority: b.priority, weight: b.weight }, actor); break;
      case "pin": await pinBanker(providerId, b.banker, b.minutes ?? null, b.reason ?? null, actor); break;
      case "unpin": await pinBanker(providerId, null, null, null, actor); break;
    }
    return NextResponse.json(await detail(providerId, staff, true));
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
