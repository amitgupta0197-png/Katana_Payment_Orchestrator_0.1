// Persona policy (PRODUCT_VISION §3.11):
//   SUPER_ADMIN — C R U D.
//   PROVIDER    — C R own.
//   MERCHANT    — C R own.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;

  try {
    const params: unknown[] = ["tenant-default"];
    let where = "tenant_id = $1";
    if (s.persona === "PROVIDER") {
      where += ` AND owner_kind = 'PROVIDER' AND owner_id = $${params.length + 1}`;
      params.push(s.scope_id);
    } else if (s.persona === "MERCHANT") {
      where += ` AND owner_kind = 'MERCHANT' AND owner_id = $${params.length + 1}`;
      params.push(s.scope_id);
    }
    const keys = await rows<any>("auth", `
      SELECT id, label, owner_kind, owner_id, prefix, scopes, status,
             created_at, last_used_at, revoked_at
        FROM api_keys
       WHERE ${where}
       ORDER BY created_at DESC LIMIT 200
    `, params);

    // Enrich with owner legal_name + KYC status from provider/merchant dbs.
    // The api_keys table only carries owner_id; the UI needs to search by
    // human-readable name + filter by KYC-approved owners.
    const providerIds = [...new Set(keys.filter((k) => k.owner_kind === "PROVIDER").map((k) => k.owner_id))];
    const merchantIds = [...new Set(keys.filter((k) => k.owner_kind === "MERCHANT").map((k) => k.owner_id))];

    const providerMap = new Map<string, { legal_name: string; kyc_status: string; status: string }>();
    const merchantMap = new Map<string, { legal_name: string; stage: string; risk_tier?: string }>();

    if (providerIds.length) {
      const pr = await rows<{ id: string; legal_name: string; kyc_status: string; status: string }>(
        "provider",
        `SELECT id::text, legal_name, COALESCE(kyc_status,'') AS kyc_status, COALESCE(status,'') AS status
           FROM providers WHERE id = ANY($1::uuid[])`,
        [providerIds],
      ).catch(() => []);
      for (const p of pr) providerMap.set(p.id, { legal_name: p.legal_name, kyc_status: p.kyc_status, status: p.status });
    }
    if (merchantIds.length) {
      const mr = await rows<{ merchant_code: string; legal_name: string; stage: string; risk_tier?: string }>(
        "merchant",
        `SELECT merchant_code, legal_name, COALESCE(stage,'') AS stage, COALESCE(risk_tier,'') AS risk_tier
           FROM merchants WHERE merchant_code = ANY($1::text[])`,
        [merchantIds],
      ).catch(() => []);
      for (const m of mr) merchantMap.set(m.merchant_code, { legal_name: m.legal_name, stage: m.stage, risk_tier: m.risk_tier });
    }

    const enriched = keys.map((k) => {
      if (k.owner_kind === "PROVIDER") {
        const p = providerMap.get(k.owner_id);
        return { ...k, owner_name: p?.legal_name ?? "", owner_kyc_status: p?.kyc_status ?? "", owner_status: p?.status ?? "" };
      }
      if (k.owner_kind === "MERCHANT") {
        const m = merchantMap.get(k.owner_id);
        // Merchant "kyc" is the stage: LIVE is effectively post-KYB approval.
        return {
          ...k, owner_name: m?.legal_name ?? "",
          owner_kyc_status: m?.stage === "LIVE" ? "APPROVED" : m?.stage ?? "",
          owner_status: m?.stage ?? "",
        };
      }
      return { ...k, owner_name: "Katana platform", owner_kyc_status: "APPROVED", owner_status: "ACTIVE" };
    });

    return NextResponse.json({ keys: enriched });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
