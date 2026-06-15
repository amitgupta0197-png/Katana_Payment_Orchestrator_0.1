// Persona-derived scope helpers.
//
// Principle (PRODUCT_VISION §1.2 #1): no persona sees data outside its scope.
// We enforce that at the BFF SQL layer by deriving a WHERE fragment from the
// session and refusing to run queries that can't be scoped.
//
// SUPER_ADMIN  → no extra WHERE; sees the tenant-wide row set.
// PROVIDER     → `tenant_id = $tenant AND provider_id = $scope`.
//                For tables without a direct provider_id (e.g. checkout_orders,
//                payin/payout, ledger), we resolve via provider_merchant_mappings.
// MERCHANT     → `tenant_id = $tenant AND merchant_id = $scope`.
//
// Callers compose the fragment into their query and append the params returned.

import type { Session, Persona } from "./auth";

export interface ScopeFilter {
  // Composable SQL — already wrapped in parentheses; safe to AND.
  where: string;
  // Positional parameters this fragment introduces, in order.
  params: unknown[];
  // Convenience for the caller: persona of the session that produced this filter.
  persona: Persona;
  // Convenience: which subject id (provider_id or merchant_id) is in scope.
  scope_id: string | null;
}

const DEFAULT_TENANT = "tenant-default";

// scopeFor — produce a WHERE fragment + params for the given session, applied
// against a table whose ownership columns are described by `cols`. The `nextParam`
// argument is the 1-based positional parameter index to start at — pass the
// number of params the caller has already bound.
//
// For tables where the only ownership column is `provider_id`, a MERCHANT
// session is rejected (caller must use a join through provider_merchant_mappings).
// For tables where the only ownership column is `merchant_id`, a PROVIDER session
// can be scoped via `providerMerchantJoin()`.
export function scopeFor(
  s: Session,
  cols: { tenant?: string; provider?: string; merchant?: string },
  nextParam: number,
): ScopeFilter {
  const where: string[] = [];
  const params: unknown[] = [];
  let i = nextParam;
  const tenant = cols.tenant ?? "tenant_id";

  // Tenant scoping is always applied if the table has the column.
  if (cols.tenant !== null) {
    where.push(`${tenant} = $${i++}`);
    params.push(DEFAULT_TENANT);
  }

  if (s.persona === "SUPER_ADMIN") {
    return { where: where.length ? `(${where.join(" AND ")})` : "TRUE", params, persona: s.persona, scope_id: null };
  }

  if (s.persona === "PROVIDER") {
    if (!s.scope_id) throw new Error("PROVIDER session missing scope_id");
    if (!cols.provider) throw new Error("table not provider-scopable; use providerMerchantJoin()");
    where.push(`${cols.provider} = $${i++}::uuid`);
    params.push(s.scope_id);
    return { where: `(${where.join(" AND ")})`, params, persona: s.persona, scope_id: s.scope_id };
  }

  if (s.persona === "MERCHANT") {
    if (!s.scope_id) throw new Error("MERCHANT session missing scope_id");
    if (!cols.merchant) throw new Error("table not merchant-scopable");
    where.push(`${cols.merchant} = $${i++}`);
    params.push(s.scope_id);
    return { where: `(${where.join(" AND ")})`, params, persona: s.persona, scope_id: s.scope_id };
  }

  // Defense-in-depth: unknown persona returns a guaranteed-empty filter.
  return { where: "FALSE", params: [], persona: s.persona, scope_id: null };
}

// providerMerchantJoin — for tables that only have merchant_id, produce a
// subquery fragment a caller can use as `merchant_id IN (<sub>)` to scope a
// PROVIDER session through the mapping table. SUPER_ADMIN returns TRUE,
// MERCHANT returns `merchant_id = $scope`.
export function providerMerchantJoin(
  s: Session,
  cols: { tenant?: string; merchant: string },
  nextParam: number,
): ScopeFilter {
  const where: string[] = [];
  const params: unknown[] = [];
  let i = nextParam;
  const tenant = cols.tenant ?? "tenant_id";

  if (cols.tenant !== null) {
    where.push(`${tenant} = $${i++}`);
    params.push(DEFAULT_TENANT);
  }

  if (s.persona === "SUPER_ADMIN") {
    return { where: where.length ? `(${where.join(" AND ")})` : "TRUE", params, persona: s.persona, scope_id: null };
  }

  if (s.persona === "PROVIDER") {
    if (!s.scope_id) throw new Error("PROVIDER session missing scope_id");
    where.push(`${cols.merchant} = ANY($${i++}::text[])`);
    params.push("__PROVIDER_MERCHANT_IDS__"); // placeholder, caller substitutes
    return { where: `(${where.join(" AND ")})`, params, persona: s.persona, scope_id: s.scope_id };
  }

  if (s.persona === "MERCHANT") {
    if (!s.scope_id) throw new Error("MERCHANT session missing scope_id");
    where.push(`${cols.merchant} = $${i++}`);
    params.push(s.scope_id);
    return { where: `(${where.join(" AND ")})`, params, persona: s.persona, scope_id: s.scope_id };
  }

  return { where: "FALSE", params: [], persona: s.persona, scope_id: null };
}

import { rows } from "./pg";

export async function resolveProviderMerchants(s: Session): Promise<string[]> {
  if (s.persona !== "PROVIDER" || !s.scope_id) return [];
  // provider_merchant_mappings has no `status` column in this schema;
  // existence of the row is the active state. The merchant_id is a string
  // (merchant_code), not a uuid — matches checkout_orders.merchant_id etc.
  const r = await rows<{ merchant_id: string }>(
    "provider",
    `SELECT merchant_id::text AS merchant_id
       FROM provider_merchant_mappings
      WHERE provider_id = $1::uuid`,
    [s.scope_id],
  );
  return r.map((x) => x.merchant_id);
}

import { getSession, requirePersona } from "./auth";

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function gate(allowed: Persona[]): Promise<Session> {
  const s = await getSession();
  const g = requirePersona(s, ...allowed);
  if (!g.ok) throw new HttpError(g.status, g.error);
  return g.session;
}

import { NextResponse } from "next/server";

export async function gateOrResponse(allowed: Persona[]): Promise<{ session: Session } | { response: NextResponse }> {
  try {
    return { session: await gate(allowed) };
  } catch (e) {
    if (e instanceof HttpError) {
      return { response: NextResponse.json({ error: e.message }, { status: e.status }) };
    }
    throw e;
  }
}
