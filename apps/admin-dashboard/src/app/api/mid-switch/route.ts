// The MID switch (lib/mid-switch): a banker's pay-in traffic between its own MIDs.
//
//   GET  /api/mid-switch                 the bankers in scope, with what each switch is doing now
//   GET  /api/mid-switch?banker=CODE     one banker: settings per kind, every MID with today's
//                                        usage, health and whether it takes traffic now, the log
//   POST /api/mid-switch                 { banker, action, … }
//        add       { kind, upi_id | vault_label, name?, …limits }   a UPI ID set up on the account,
//                  or (staff only) one of its processor accounts
//        update    { mid_id, …fields }        limits, priority, weight, hours, health rule
//        pause / resume { mid_id, reason? }   disable { mid_id, reason } (staff)
//        settings  { kind, enabled?, mode? }  switch on / off, PRIORITY or WEIGHTED
//        pin       { kind, mid_id, minutes?, reason? }   the manual switch; unpin { kind }
//
// Staff see and change every banker; a merchant (PROVIDER) its own bankers; a banker (MERCHANT)
// itself (lib/portal-scope). A merchant or banker is never shown a processor's name.

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError, rows } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { PORTAL_PERSONAS, inScope, portalScope } from "@/lib/portal-scope";
import { DEFAULT_SETTINGS, healthRuleFromEnv, MID_KINDS, MID_MODES, type MidKind } from "@/lib/mid-switch";
import {
  addMid, bankerGatewayAccounts, bankerUpiIds, getMid, getSettings, listMidEvents, midsWithState, MidSwitchError,
  pinMid, saveSettings, setMidStatus, updateMid,
} from "@/lib/mid-switch-store";
import { actorWords, eventWords, midViewRow } from "@/lib/mid-switch-view";
import { stripGatewayNames } from "@/lib/merchant-safe";

export const dynamic = "force-dynamic";

const notFound = () => NextResponse.json({ error: "not found" }, { status: 404 });

export async function GET(req: Request) {
  const g = await gateOrResponse(PORTAL_PERSONAS);
  if ("response" in g) return g.response;
  try {
    const scope = await portalScope(g.session);
    const banker = new URL(req.url).searchParams.get("banker")?.trim();
    if (!banker) return NextResponse.json({ bankers: await summary(scope.codes), staff: scope.staff });
    if (!scope.staff && !inScope(scope, banker)) return notFound();
    return NextResponse.json(await detail(banker, scope.staff));
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

/** Every banker in scope (staff: every banker, those with MIDs first), with each kind's state now. */
async function summary(codes: string[] | null) {
  const names = codes
    ? await rows<{ code: string; name: string }>("merchant",
      `SELECT merchant_code AS code, COALESCE(NULLIF(brand_name,''), legal_name) AS name FROM merchants WHERE merchant_code = ANY($1::text[])`, [codes]).catch(() => [])
    : await rows<{ code: string; name: string }>("merchant",
      `SELECT merchant_code AS code, COALESCE(NULLIF(brand_name,''), legal_name) AS name FROM merchants
        WHERE merchant_code IS NOT NULL ORDER BY 2, 1 LIMIT 5000`);
  const withMids = codes ? [] : (await rows<{ b: string }>("vendorGateway", `SELECT DISTINCT banker_code AS b FROM payin_mids ORDER BY 1`)).map((r) => r.b);
  const bankers = codes ?? [...new Set([...withMids, ...names.map((n) => n.code)])];
  if (!bankers.length) return [];
  const mids = await rows<{ banker_code: string; kind: string; total: number; active: number }>("vendorGateway", `
    SELECT banker_code, kind, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active
      FROM payin_mids WHERE banker_code = ANY($1::text[]) GROUP BY 1, 2`, [bankers]);
  return bankers.map((b) => ({
    banker: b, name: names.find((n) => n.code === b)?.name ?? b,
    kinds: Object.fromEntries(MID_KINDS.map((k) => {
      const m = mids.find((x) => x.banker_code === b && x.kind === k);
      return [k, { total: m?.total ?? 0, active: m?.active ?? 0 }];
    })),
  }));
}

async function detail(banker: string, staff: boolean) {
  const now = new Date();
  const rule = healthRuleFromEnv();
  const [{ mids }, settingsG, settingsU, events, upiIds, accounts] = await Promise.all([
    midsWithState(banker), getSettings(banker, "GATEWAY"), getSettings(banker, "UPI"), listMidEvents(banker, 60),
    bankerUpiIds(banker), bankerGatewayAccounts(banker),
  ]);
  const settings: Record<MidKind, typeof settingsG> = { GATEWAY: settingsG, UPI: settingsU };
  const view = mids.map((m) => midViewRow(m, {
    staff, settings: settings[m.kind], now, rule,
    account: m.vault_label ? accounts.find((a) => a.vault_label === m.vault_label) ?? null : null,
  }));
  const used = new Set(mids.map((m) => (m.kind === "UPI" ? m.upi_id : m.vault_label)));
  return {
    banker, staff,
    settings: Object.fromEntries(MID_KINDS.map((k) => {
      const s = settings[k];
      return [k, { enabled: s.enabled, mode: s.mode, pinned_mid_id: s.pinned_mid_id, pinned_until: s.pinned_until,
        pin_reason: s.pin_reason ? (staff ? s.pin_reason : stripGatewayNames(s.pin_reason, "processor")) : null,
        last_mid_id: s.last_mid_id, in_use: mids.some((m) => m.kind === k) && s.enabled }];
    })),
    mids: view,
    can_add: {
      UPI: upiIds.filter((u) => !used.has(u)),
      // Staff add processor accounts (they hold the credentials); merchants only learn how many exist.
      GATEWAY: staff ? accounts.filter((a) => !used.has(a.vault_label)) : [],
      gateway_accounts_not_added: accounts.filter((a) => !used.has(a.vault_label)).length,
    },
    events: events.map((e) => ({
      at: e.at, kind: e.kind, mid_id: e.mid_id, action: e.action, who: actorWords(e.actor, staff), text: eventWords(e, staff),
    })),
    health_rule: rule,
    defaults: DEFAULT_SETTINGS,
  };
}

const money = z.preprocess((v) => (v === "" || v == null ? null : v), z.coerce.number().positive().max(1_000_000_000).nullable());
const fields = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  payee_name: z.preprocess((v) => (v === "" ? null : v), z.string().trim().max(80).nullable()).optional(),
  priority: z.coerce.number().int().min(1).max(99).optional(),
  weight: z.coerce.number().int().min(0).max(100).optional(),
  min_amount: money.optional(), max_amount: money.optional(), daily_amount: money.optional(), monthly_amount: money.optional(),
  daily_count: z.preprocess((v) => (v === "" || v == null ? null : v), z.coerce.number().int().positive().nullable()).optional(),
  active_from: z.preprocess((v) => (v === "" ? null : v), z.string().regex(/^\d{2}:\d{2}$/).nullable()).optional(),
  active_to: z.preprocess((v) => (v === "" ? null : v), z.string().regex(/^\d{2}:\d{2}$/).nullable()).optional(),
  active_days: z.array(z.number().int().min(1).max(7)).nullable().optional(),
  skip_unhealthy: z.boolean().optional(),
  health_min_success: z.preprocess((v) => (v === "" || v == null ? null : v), z.coerce.number().int().min(1).max(100).nullable()).optional(),
});
const kind = z.enum(MID_KINDS);
const body = z.discriminatedUnion("action", [
  fields.extend({ action: z.literal("add"), banker: z.string(), kind, upi_id: z.string().optional(), vault_label: z.string().optional() }),
  fields.extend({ action: z.literal("update"), banker: z.string(), mid_id: z.string().uuid() }),
  z.object({ action: z.enum(["pause", "resume", "disable"]), banker: z.string(), mid_id: z.string().uuid(), reason: z.string().trim().max(200).optional() }),
  z.object({ action: z.literal("settings"), banker: z.string(), kind, enabled: z.boolean().optional(), mode: z.enum(MID_MODES).optional() }),
  z.object({ action: z.literal("pin"), banker: z.string(), kind, mid_id: z.string().uuid(), minutes: z.coerce.number().int().min(5).max(7 * 24 * 60).nullish(), reason: z.string().trim().max(200).optional() }),
  z.object({ action: z.literal("unpin"), banker: z.string(), kind }),
]);

/** Staff who manage every banker's switch. */
const SWITCH_STAFF = new Set(["SUPER_ADMIN", "ADMIN", "OPERATOR"]);

export async function POST(req: Request) {
  const g = await gateOrResponse(PORTAL_PERSONAS);
  if ("response" in g) return g.response;
  const s = g.session;
  let b: z.infer<typeof body>;
  try { b = body.parse(await req.json()); } catch (e) {
    const msg = e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : "invalid JSON";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
  try {
    const scope = await portalScope(s);
    if (scope.staff && !SWITCH_STAFF.has(s.persona)) return NextResponse.json({ error: "your role cannot change a MID switch" }, { status: 403 });
    if (!scope.staff && !inScope(scope, b.banker)) return notFound();
    const actor = scope.staff ? `katana:${s.email}` : s.email;
    // A MID named in the request must be this banker's.
    if ("mid_id" in b && b.action !== "pin") {
      const m = await getMid(b.mid_id);
      if (!m || m.banker_code !== b.banker) return notFound();
    }
    switch (b.action) {
      case "add": {
        if (b.kind === "GATEWAY" && !scope.staff) return NextResponse.json({ error: "Katana adds processor accounts; ask Katana support" }, { status: 403 });
        const { action: _a, banker, kind: k, upi_id, vault_label, ...f } = b;
        await addMid({ banker, kind: k, upi_id, vault_label, ...f }, actor);
        break;
      }
      case "update": {
        const { action: _a, banker: _b, mid_id, ...f } = b;
        await updateMid(mid_id, f, actor);
        break;
      }
      case "pause": await setMidStatus(b.mid_id, "PAUSED", b.reason ?? null, actor); break;
      case "resume": await setMidStatus(b.mid_id, "ACTIVE", null, actor); break;
      case "disable":
        if (!scope.staff) return NextResponse.json({ error: "pause it instead; Katana disables MIDs" }, { status: 403 });
        await setMidStatus(b.mid_id, "DISABLED", b.reason ?? null, actor); break;
      case "settings": await saveSettings(b.banker, b.kind, { enabled: b.enabled, mode: b.mode }, actor); break;
      case "pin": await pinMid(b.banker, b.kind, b.mid_id, b.minutes ?? null, b.reason ?? null, actor); break;
      case "unpin": await pinMid(b.banker, b.kind, null, null, null, actor); break;
    }
    return NextResponse.json(await detail(b.banker, scope.staff));
  } catch (err) {
    if (err instanceof MidSwitchError) return NextResponse.json({ error: err.message }, { status: err.status });
    const e = pgError(err); return NextResponse.json(e.body, { status: e.status });
  }
}
