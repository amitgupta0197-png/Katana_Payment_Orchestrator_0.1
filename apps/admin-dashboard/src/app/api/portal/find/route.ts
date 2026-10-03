// GET /api/portal/find?q=: find a payment by txnid, order id, UTR, amount or the customer's
// phone, and tell each match as a short story (lib/payment-search). Merchant (PROVIDER) and
// banker (MERCHANT) logins, on their own bankers only.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { portalScope } from "@/lib/portal-scope";
import { searchPayments } from "@/lib/payment-search";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim().slice(0, 100);
  if (!q) return NextResponse.json({ query: q, kinds: [], results: [] });
  try {
    const scope = await portalScope(g.session);
    const codes = scope.codes ?? [];
    const names = codes.length > 1 ? Object.fromEntries((await rows<{ code: string; name: string }>("merchant", `
      SELECT merchant_code AS code, COALESCE(NULLIF(brand_name, ''), legal_name, merchant_code) AS name
        FROM merchants WHERE merchant_code = ANY($1::text[])`, [codes]).catch(() => [])).map((r) => [r.code, r.name])) : {};
    return NextResponse.json({ query: q, ...(await searchPayments(q, codes, names)) });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
