// Chargeback debit rules (payin_chargeback_rules): which share of a banker-side chargeback is
// debited to the merchant, per merchant, optionally per banker, channel and reason code.
//
//   GET  /api/chargebacks/rules[?all=1]   staff: every rule (all=1 includes ended ones);
//        a merchant or banker: the rules in force that apply to it, as its "terms".
//   POST /api/chargebacks/rules           staff set a rule. Rules are versioned, never edited:
//        a new rule for exactly the same scope ends the one in force.
//        { action: "end", id }             end a rule with no replacement.
//
// No rule exists until staff set one, and with none a chargeback is never debited.

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError, rows } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { PORTAL_PERSONAS, portalScope } from "@/lib/portal-scope";
import { CB_STAFF } from "@/lib/chargeback-rules";
import { createCbRule, endCbRule, listCbRules } from "@/lib/chargebacks-store";
import { providerForMerchant } from "@/lib/provider-integration";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(PORTAL_PERSONAS);
  if ("response" in g) return g.response;
  const s = g.session;
  try {
    const scope = await portalScope(s);
    if (scope.staff) {
      const all = new URL(req.url).searchParams.get("all") === "1";
      return NextResponse.json({ rules: await listCbRules({ includeEnded: all }) });
    }
    // A merchant's own terms: rules for every merchant, for it, and for its bankers.
    const providerId = s.persona === "PROVIDER" ? s.scope_id ?? null
      : scope.codes?.[0] ? await providerForMerchant(scope.codes[0]) : null;
    const rules = (await listCbRules({ providerId })).filter((r) => r.banker_code == null || scope.codes?.includes(r.banker_code));
    return NextResponse.json({
      rules: rules.map((r) => ({
        channel: r.channel_type, banker: r.banker_code, reason_code: r.reason_code,
        debit_ratio: `${(r.debit_bps / 100).toFixed(2).replace(/\.00$/, "")}%`, version: r.version, since: r.effective_from,
        for_everyone: r.provider_id == null,
      })),
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const nul = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const create = z.object({
  provider_id: z.preprocess(nul, z.string().uuid().nullable()),
  banker_code: z.preprocess(nul, z.string().max(120).nullable()),
  channel_type: z.preprocess((v) => (nul(v) ? String(v).toUpperCase() : null), z.enum(["INTENT", "P2P"]).nullable()),
  reason_code: z.preprocess((v) => (nul(v) ? String(v).trim().toUpperCase() : null), z.string().max(40).nullable()),
  debit_percent: z.coerce.number().min(0).max(100),
  auto_debit: z.boolean().default(true),
  auto_max_amount: z.preprocess((v) => (v === "" || v == null ? null : v), z.coerce.number().positive().nullable()),
  note: z.string().trim().min(3).max(500),
});
const end = z.object({ action: z.literal("end"), id: z.string().uuid() });

export async function POST(req: Request) {
  const g = await gateOrResponse([...CB_STAFF]);
  if ("response" in g) return g.response;
  const s = g.session;
  let raw: unknown;
  try { raw = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  try {
    const e = end.safeParse(raw);
    if (e.success) {
      return (await endCbRule(e.data.id)) ? NextResponse.json({ ended: true }) : NextResponse.json({ error: "not found or already ended" }, { status: 404 });
    }
    const p = create.safeParse(raw);
    if (!p.success) return NextResponse.json({ error: p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, { status: 400 });
    const r = p.data;
    // A rule for one banker belongs to that banker's merchant.
    let providerId = r.provider_id;
    if (r.banker_code) {
      const code = (await rows<{ merchant_code: string }>("merchant",
        `SELECT merchant_code FROM merchants WHERE merchant_code = $1 OR id::text = $1 LIMIT 1`, [r.banker_code]))[0]?.merchant_code;
      if (!code) return NextResponse.json({ error: "no banker has that code" }, { status: 404 });
      r.banker_code = code;
      const owner = await providerForMerchant(code);
      if (providerId && owner && owner !== providerId) return NextResponse.json({ error: "that banker belongs to another merchant" }, { status: 422 });
      providerId = owner ?? providerId;
    }
    const rule = await createCbRule({
      provider_id: providerId, banker_code: r.banker_code, channel_type: r.channel_type, reason_code: r.reason_code,
      debit_bps: Math.round(r.debit_percent * 100), auto_debit: r.auto_debit, auto_max_amount: r.auto_max_amount, note: r.note,
    }, s.email);
    return NextResponse.json({ rule }, { status: 201 });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
