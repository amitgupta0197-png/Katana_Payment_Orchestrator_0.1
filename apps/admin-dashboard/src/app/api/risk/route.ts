// Persona policy (PRODUCT_VISION §3.9):
//   SUPER_ADMIN — C R U D (rules + blacklist + chargebacks).
//   PROVIDER    — R mapped only.
//   MERCHANT    — R own only.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse, resolveProviderMerchants } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;

  const url = new URL(req.url);
  const kind = url.searchParams.get("kind") ?? "chargebacks";

  try {
    const params: unknown[] = ["tenant-default"];
    let where = "tenant_id = $1";
    if (s.persona === "MERCHANT") {
      where += ` AND merchant_id = $${params.length + 1}`;
      params.push(s.scope_id);
    } else if (s.persona === "PROVIDER") {
      const ids = await resolveProviderMerchants(s);
      if (!ids.length) return NextResponse.json({ items: [], kind });
      where += ` AND merchant_id = ANY($${params.length + 1}::text[])`;
      params.push(ids);
    }

    if (kind === "chargebacks") {
      const items = await rows<any>("riskVelocity", `
        SELECT id, tenant_id, merchant_id, txn_id, amount, reason_code, status,
               opened_at, COALESCE(deadline,'1970-01-01'::timestamp) AS deadline
          FROM chargebacks
         WHERE ${where}
         ORDER BY opened_at DESC LIMIT 200
      `, params).catch(() => []);
      return NextResponse.json({ items, kind });
    }
    if (kind === "rules" && s.persona === "SUPER_ADMIN") {
      const items = await rows<any>("riskVelocity", `
        SELECT id, name, window_seconds, cap, kind, enabled, created_at
          FROM velocity_rules ORDER BY created_at DESC LIMIT 200
      `).catch(() => []);
      return NextResponse.json({ items, kind });
    }
    if (kind === "blacklist" && s.persona === "SUPER_ADMIN") {
      const items = await rows<any>("riskVelocity", `
        SELECT id, kind, value, reason, created_at FROM blacklist_entries
         ORDER BY created_at DESC LIMIT 200
      `).catch(() => []);
      return NextResponse.json({ items, kind });
    }
    return NextResponse.json({ items: [], kind });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
