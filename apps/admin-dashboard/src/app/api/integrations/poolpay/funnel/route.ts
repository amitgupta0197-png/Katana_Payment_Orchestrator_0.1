// PoolPay (Katana Pay) reconciliation funnel.
//
// Returns the pay-in pipeline for a scope so the provider dashboard, the branch
// (merchant) dashboard, and the admin provider-detail Integration tab can all
// render the SAME funnel from one source. Scope resolution:
//
//   ?merchant=<code|uuid>  → one branch (caller must be allowed to see it)
//   ?provider=<id>         → all branches under that provider
//   (none) + PROVIDER      → caller's own provider portfolio
//   (none) + MERCHANT      → caller's own branch
//   (none) + SUPER_ADMIN   → global (all PoolPay pay-ins)
//
// The funnel mirrors the document's lifecycle: created → pending → needs-action
// (high-amount hold / proof awaiting review) → success / failed / expired, plus a
// settled count and the success conversion %.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { resolveMerchantScope } from "@/lib/merchant-keys";
import { branchKeysForMerchant, branchKeysForProvider } from "@/lib/provider-integration";

export const dynamic = "force-dynamic";

const STAGES = [
  { key: "created", label: "Created" },
  { key: "pending", label: "Pending" },
  { key: "needs_action", label: "Needs action" },
  { key: "success", label: "Success" },
  { key: "failed", label: "Failed" },
  { key: "expired", label: "Expired" },
] as const;

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const url = new URL(req.url);
  const merchantParam = url.searchParams.get("merchant");
  const providerParam = url.searchParams.get("provider");

  // Resolve the scope → either a key list (provider/merchant) or null (global).
  let scopeType: "global" | "provider" | "merchant" = "global";
  let scopeId: string | null = null;
  let keys: string[] | null = null;

  try {
    if (merchantParam) {
      const scope = await resolveMerchantScope(merchantParam, s);
      if ("response" in scope) return scope.response;
      scopeType = "merchant"; scopeId = scope.code;
      keys = await branchKeysForMerchant(scope.code);
    } else if (providerParam || s.persona === "PROVIDER") {
      const providerId = providerParam ?? s.scope_id!;
      if (s.persona === "PROVIDER" && s.scope_id !== providerId)
        return NextResponse.json({ error: "providers can only read own funnel" }, { status: 403 });
      scopeType = "provider"; scopeId = providerId;
      keys = await branchKeysForProvider(providerId);
    } else if (s.persona === "MERCHANT") {
      scopeType = "merchant"; scopeId = s.scope_id;
      keys = await branchKeysForMerchant(s.scope_id!);
    } else {
      scopeType = "global"; scopeId = null; keys = null; // SUPER_ADMIN, no filter
    }
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }

  // A scoped query with no matching branches → an empty (but valid) funnel.
  if (keys && keys.length === 0) {
    return NextResponse.json({
      scope: { type: scopeType, id: scopeId },
      totals: { count: 0, amount: 0 },
      stages: STAGES.map((st) => ({ ...st, count: 0, amount: 0 })),
      settled_count: 0, conversion_pct: null, needs_action: 0,
      by_status: {},
    });
  }

  const where = keys ? "vendor = 'POOLPAY' AND merchant_id = ANY($1::text[])" : "vendor = 'POOLPAY'";
  const args = keys ? [keys] : [];

  try {
    const agg = await rows<any>("vendorGateway", `
      SELECT
        COUNT(*)::int AS created_count,
        COALESCE(SUM(amount),0)::float AS created_amount,
        COUNT(*) FILTER (WHERE status IN ('SUCCESS','SUCCEEDED'))::int AS success_count,
        COALESCE(SUM(amount) FILTER (WHERE status IN ('SUCCESS','SUCCEEDED')),0)::float AS success_amount,
        COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed_count,
        COALESCE(SUM(amount) FILTER (WHERE status = 'FAILED'),0)::float AS failed_amount,
        COUNT(*) FILTER (WHERE status = 'EXPIRED')::int AS expired_count,
        COALESCE(SUM(amount) FILTER (WHERE status = 'EXPIRED'),0)::float AS expired_amount,
        COUNT(*) FILTER (
          WHERE status NOT IN ('SUCCESS','SUCCEEDED','FAILED','EXPIRED')
            AND (meta->>'hold' = 'true' OR meta->>'review' = 'PROOF_SUBMITTED')
        )::int AS needs_action_count,
        COALESCE(SUM(amount) FILTER (
          WHERE status NOT IN ('SUCCESS','SUCCEEDED','FAILED','EXPIRED')
            AND (meta->>'hold' = 'true' OR meta->>'review' = 'PROOF_SUBMITTED')
        ),0)::float AS needs_action_amount,
        COUNT(*) FILTER (
          WHERE status NOT IN ('SUCCESS','SUCCEEDED','FAILED','EXPIRED')
            AND NOT (meta->>'hold' = 'true' OR meta->>'review' = 'PROOF_SUBMITTED')
        )::int AS pending_count,
        COALESCE(SUM(amount) FILTER (
          WHERE status NOT IN ('SUCCESS','SUCCEEDED','FAILED','EXPIRED')
            AND NOT (meta->>'hold' = 'true' OR meta->>'review' = 'PROOF_SUBMITTED')
        ),0)::float AS pending_amount,
        COUNT(*) FILTER (WHERE meta->'settlement'->>'status' = 'SETTLED')::int AS settled_count
      FROM vendor_payin_orders
      WHERE ${where}
    `, args);

    const a = agg[0] ?? {};
    const created = a.created_count ?? 0;
    const success = a.success_count ?? 0;
    const terminal = success + (a.failed_count ?? 0) + (a.expired_count ?? 0);
    const stages = [
      { key: "created",      label: "Created",      count: created,                 amount: a.created_amount ?? 0 },
      { key: "pending",      label: "Pending",      count: a.pending_count ?? 0,     amount: a.pending_amount ?? 0 },
      { key: "needs_action", label: "Needs action", count: a.needs_action_count ?? 0, amount: a.needs_action_amount ?? 0 },
      { key: "success",      label: "Success",      count: success,                 amount: a.success_amount ?? 0 },
      { key: "failed",       label: "Failed",       count: a.failed_count ?? 0,      amount: a.failed_amount ?? 0 },
      { key: "expired",      label: "Expired",      count: a.expired_count ?? 0,     amount: a.expired_amount ?? 0 },
    ];

    return NextResponse.json({
      scope: { type: scopeType, id: scopeId },
      totals: { count: created, amount: a.created_amount ?? 0 },
      stages,
      settled_count: a.settled_count ?? 0,
      needs_action: a.needs_action_count ?? 0,
      // Conversion = settled outcome success / all terminal outcomes (null if none resolved yet).
      conversion_pct: terminal > 0 ? Math.round((success / terminal) * 1000) / 10 : null,
      by_status: {
        success, failed: a.failed_count ?? 0, expired: a.expired_count ?? 0,
        pending: a.pending_count ?? 0, needs_action: a.needs_action_count ?? 0,
      },
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
