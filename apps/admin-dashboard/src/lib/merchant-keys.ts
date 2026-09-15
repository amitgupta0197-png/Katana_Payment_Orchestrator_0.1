// Shared scope resolver for merchant-scoped API key routes.
// Lives in lib/ (not a route file) so it can be imported by multiple route handlers.

import { NextResponse } from "next/server";
import { rows } from "@/lib/pg";
import { resolveProviderMerchants } from "@/lib/scope";
import type { Session } from "@/lib/auth";

// Resolve the merchant_code for [id] and enforce persona scope.
// Returns { code } on success or { response } to short-circuit the handler.
export async function resolveMerchantScope(
  id: string,
  session: Session,
): Promise<{ code: string } | { response: NextResponse }> {
  const m = await rows<{ merchant_code: string }>("merchant", `SELECT merchant_code FROM merchants WHERE id = $1::uuid`, [id]);
  if (!m.length) return { response: NextResponse.json({ error: "merchant not found" }, { status: 404 }) };
  const code = m[0].merchant_code;
  if (session.persona === "PROVIDER") {
    const codes = await resolveProviderMerchants(session);
    if (!codes.includes(code))
      return { response: NextResponse.json({ error: "merchant not mapped to your merchant" }, { status: 403 }) };
  }
  return { code };
}

// A MERCHANT session's own merchant_code. Its scope_id IS the cross-service merchant_code — the
// identity keys, orders and the checkout vault are stamped with — normalised through the merchants
// table when a row exists; demo / seed personas have none, so scope_id is used as-is.
export async function ownMerchantCode(scopeId: string | null): Promise<string | null> {
  if (!scopeId) return null;
  const r = await rows<{ merchant_code: string }>(
    "merchant", `SELECT merchant_code FROM merchants WHERE merchant_code = $1 OR id::text = $1 LIMIT 1`, [scopeId],
  ).catch(() => []);
  return r[0]?.merchant_code ?? scopeId;
}
