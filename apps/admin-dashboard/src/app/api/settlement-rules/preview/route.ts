// GET /api/settlement-rules/preview?branch=&amount=[&provider=] — live charge preview
// for the raise-settlement form: resolves the applicable rule and returns the full
// gross → charges → net breakdown before anything is created.
//   SUPER_ADMIN (must pass ?provider=) + PROVIDER (own scope).

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { resolveRule, computeCharges } from "@/lib/settlement-rules";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const url = new URL(req.url);

  const providerId = s.persona === "PROVIDER" ? s.scope_id! : url.searchParams.get("provider");
  const branch = url.searchParams.get("branch") ?? "";
  const amount = Number(url.searchParams.get("amount"));
  if (!providerId || !branch || !(amount > 0))
    return NextResponse.json({ error: "provider, branch and a positive amount are required" }, { status: 400 });

  try {
    const rule = await resolveRule(providerId, branch);
    const breakdown = computeCharges(amount, rule);
    return NextResponse.json({ breakdown, rule_scope: rule.id ? { provider_id: rule.provider_id, merchant_key: rule.merchant_key, version: rule.version } : null });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
