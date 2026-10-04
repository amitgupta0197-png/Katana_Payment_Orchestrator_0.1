// The Settlement Engine (lib/settlement-engine, -store).
//   GET  ?banker=CODE   that banker: balances (from the ledger), active + pending config, pause,
//                       recent settlements with their history. Staff any banker; a merchant
//                       (PROVIDER) only its own bankers, read-only.
//   GET  (no banker)    staff: every banker with a config, its state and balances.
//   POST {action, …}    staff only:
//     propose  {banker, body, note}           a new config version, waiting for a second person
//     decide   {config_id, approve, note}     approve / reject; never the person who proposed it
//     pause / resume {banker, reason}
//     raise    {banker, amount_minor?, key}   a settlement now, up to the available balance
//     cancel   {instruction_id, reason}       only one that never reached the banker
//     run      {}                             the cron's work now (sync, follow, due cycles, reserves)
// Read: SUPER_ADMIN, ADMIN, OPERATOR, FINANCE, COMPLIANCE. Change: SUPER_ADMIN, ADMIN, FINANCE.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { providerForMerchant } from "@/lib/provider-integration";
import { SETTLEMENT_TIMINGS } from "@/lib/settlement-engine";
import { syncLedger } from "@/lib/ledger-sync";
import { wormAppend } from "@/lib/worm";
import { openText } from "@/lib/sealed-text";
import {
  activeConfig, bankerBalances, cancelInstruction, configHistory, decideConfig, followRequests, instructionEvents,
  instructionsFor, isPaused, proposeConfig, raiseInstruction, releaseReserves, runDueCycles, setPaused, SettlementError,
} from "@/lib/settlement-engine-store";

export const dynamic = "force-dynamic";

const READ = ["SUPER_ADMIN", "ADMIN", "OPERATOR", "FINANCE", "COMPLIANCE", "PROVIDER"] as const;
const WRITE = ["SUPER_ADMIN", "ADMIN", "FINANCE"] as const;

const big = (v: bigint) => v.toString();

async function bankerView(banker: string, staff: boolean) {
  const [bal, cfg, history, paused, list] = await Promise.all([
    bankerBalances(banker), activeConfig(banker), configHistory(banker), isPaused(banker), instructionsFor(banker, 50),
  ]);
  const events = await Promise.all(list.slice(0, 20).map((i) => instructionEvents(i.id)));
  // The merchant's payout accounts, for choosing where settlements go; the number is never shown whole.
  const providerId = await providerForMerchant(banker);
  const bens = providerId ? await rows<{ id: string; label: string; beneficiary_name: string; bank_name: string | null; transfer_mode: string; account_number: string | null; vpa: string | null }>("provider", `
    SELECT id::text, label, beneficiary_name, bank_name, transfer_mode, account_number, vpa
      FROM provider_beneficiary_accounts WHERE provider_id = $1::uuid AND active ORDER BY created_at`, [providerId]).catch(() => []) : [];
  const last4 = (v: string | null) => { if (!v) return null; try { const t = openText(v) ?? ""; return t ? `••${t.slice(-4)}` : null; } catch { return null; } };
  return {
    banker,
    provider_id: providerId,
    beneficiaries: bens.map((x) => ({ id: x.id, label: x.label, name: x.beneficiary_name, bank: x.bank_name, mode: x.transfer_mode, account: last4(x.account_number), vpa: x.vpa })),
    balances: { payable: big(bal.payable), reserve: big(bal.reserve), in_transit: big(bal.in_transit), held_by_banker: big(bal.held_by_banker) },
    config: cfg,
    pending: history.find((h) => h.state === "PENDING_APPROVAL") ?? null,
    history: staff ? history : undefined,
    paused,
    instructions: list.map((i, n) => ({ ...i, events: n < 20 ? events[n] : undefined })),
  };
}

export async function GET(req: Request) {
  const g = await gateOrResponse([...READ]);
  if ("response" in g) return g.response;
  const s = g.session;
  const banker = new URL(req.url).searchParams.get("banker");
  try {
    if (banker) {
      if (s.persona === "PROVIDER" && (await providerForMerchant(banker)) !== s.scope_id)
        return NextResponse.json({ error: "not found" }, { status: 404 });
      return NextResponse.json(await bankerView(banker, s.persona !== "PROVIDER"));
    }
    if (s.persona === "PROVIDER") return NextResponse.json({ error: "banker required" }, { status: 400 });
    const cfgs = await rows<{ banker_code: string; state: string; version: number; timing: string }>("settlement", `
      SELECT DISTINCT ON (banker_code) banker_code, state, version, body->>'timing' AS timing
        FROM settlement_configs WHERE state IN ('ACTIVE','PENDING_APPROVAL') ORDER BY banker_code, (state = 'ACTIVE') DESC`);
    const bankers = await rows<{ code: string; name: string }>("merchant",
      `SELECT merchant_code AS code, COALESCE(NULLIF(brand_name,''), legal_name) AS name FROM merchants WHERE merchant_code IS NOT NULL ORDER BY 2, 1 LIMIT 2000`);
    const byCode = new Map(cfgs.map((c) => [c.banker_code, c]));
    return NextResponse.json({ bankers: bankers.map((b) => ({ ...b, config: byCode.get(b.code) ?? null })), timings: SETTLEMENT_TIMINGS });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const bodySchema = z.object({
  timing: z.enum(SETTLEMENT_TIMINGS),
  weekday: z.number().int().min(0).max(6).nullish(),
  run_hour_ist: z.number().int().min(0).max(23).nullish(),
  currency: z.literal("INR"),
  min_payout_minor: z.number().int().min(0),
  max_payout_minor: z.number().int().positive().nullish(),
  reserve_bps: z.number().int().min(0).max(5000),
  reserve_hold_days: z.number().int().min(0).max(365),
  tds_bps: z.number().int().min(0).max(2000),
  beneficiary_id: z.string().uuid().nullable(),
  fallback_beneficiary_ids: z.array(z.string().uuid()).max(5).optional(),
  transfer_mode: z.enum(["IMPS", "NEFT", "RTGS", "UPI"]),
  allow_on_demand: z.boolean().optional(),
});
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("propose"), banker: z.string().min(1).max(64), body: bodySchema, note: z.string().trim().max(300).optional() }),
  z.object({ action: z.literal("decide"), config_id: z.string().uuid(), approve: z.boolean(), note: z.string().trim().max(300).optional() }),
  z.object({ action: z.literal("pause"), banker: z.string().min(1).max(64), reason: z.string().trim().min(3).max(300) }),
  z.object({ action: z.literal("resume"), banker: z.string().min(1).max(64), reason: z.string().trim().max(300).optional() }),
  z.object({ action: z.literal("raise"), banker: z.string().min(1).max(64), amount_minor: z.number().int().positive().optional(), key: z.string().min(6).max(80) }),
  z.object({ action: z.literal("cancel"), instruction_id: z.string().uuid(), reason: z.string().trim().min(3).max(300) }),
  z.object({ action: z.literal("run") }),
]);

export async function POST(req: Request) {
  const g = await gateOrResponse([...WRITE]);
  if ("response" in g) return g.response;
  const by = g.session.email;
  let b;
  try { b = schema.parse(await req.json()); } catch (e) {
    const issue = (e as z.ZodError).issues?.[0];
    return NextResponse.json({ error: issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "invalid request" }, { status: 400 });
  }
  try {
    let out: unknown;
    switch (b.action) {
      case "propose": out = { config: await proposeConfig(b.banker, b.body, by, b.note ?? null) }; break;
      case "decide": out = { config: await decideConfig(b.config_id, by, b.approve, b.note ?? null) }; break;
      case "pause": await setPaused(b.banker, true, b.reason, by); out = { paused: true }; break;
      case "resume": await setPaused(b.banker, false, b.reason ?? null, by); out = { paused: false }; break;
      case "raise": out = { instruction: await raiseInstruction({ banker: b.banker, kind: "MANUAL", amount_minor: b.amount_minor != null ? BigInt(b.amount_minor) : null, actor: by, key: b.key }) }; break;
      case "cancel": out = { cancelled: await cancelInstruction(b.instruction_id, by, b.reason) }; break;
      case "run": {
        if (g.session.persona !== "SUPER_ADMIN") return NextResponse.json({ error: "only a Super Admin runs the engine by hand" }, { status: 403 });
        out = { sync: await syncLedger(), followed: await followRequests(by), cycles: await runDueCycles(new Date(), by), reserves: await releaseReserves() };
        break;
      }
    }
    await wormAppend({
      actorId: g.session.user_id, actorEmail: by, action: `settlement.engine.${b.action}`, resourceType: "settlement_engine",
      resourceId: "banker" in b ? b.banker : "config_id" in b ? b.config_id : "instruction_id" in b ? b.instruction_id : "engine",
      after: b as unknown as Record<string, unknown>,
    }).catch(() => null);
    return NextResponse.json(out, { status: b.action === "propose" || b.action === "raise" ? 201 : 200 });
  } catch (err) {
    if (err instanceof SettlementError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    const e = pgError(err); return NextResponse.json(e.body, { status: e.status });
  }
}
