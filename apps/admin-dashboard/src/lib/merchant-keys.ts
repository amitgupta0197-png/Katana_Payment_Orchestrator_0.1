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
      return { response: NextResponse.json({ error: "merchant not mapped to your provider" }, { status: 403 }) };
  }
  return { code };
}
