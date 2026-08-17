// Per-merchant payment collection config:
//   enabled_methods — which collection methods this merchant may use
//   poolpay         — PoolPay (PG pay-in) settings for this merchant
//
//   SUPER_ADMIN / PROVIDER — read + edit (PROVIDER scoped to mapped merchants)
//   MERCHANT               — read own

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { resolveMerchantScope } from "@/lib/merchant-keys";

export const dynamic = "force-dynamic";

const METHODS = ["UPI_INTENT", "UPI_COLLECT", "CARD", "NETBANKING", "WALLET", "QR", "CRYPTO"] as const;
const DEFAULT_METHODS: string[] = [...METHODS];

const patchSchema = z.object({
  enabled_methods: z.array(z.enum(["UPI_INTENT", "UPI_COLLECT", "CARD", "NETBANKING", "WALLET", "QR", "CRYPTO"])).optional(),
  blocked: z.boolean().optional(),
  poolpay: z.object({
    enabled: z.boolean().optional(),
    pay_id: z.string().max(120).optional(),
    // The single payee a Katana Pay order is paid TO.
    settlement_vpa: z.string().max(120).optional(),
    // Additional UPI IDs this banker also receives on. Recognised when attributing and
    // reporting captured credits; never used as a payee. Trimmed, lowercased and deduped
    // here so every reader can compare them directly against a captured payee_vpa.
    settlement_vpas: z.array(z.string().max(120)).max(20).optional()
      .transform((v) => v && [...new Set(v.map((s) => s.trim().toLowerCase()).filter(Boolean))]),
    // WHICH BUSINESS COLLECTS ON WHICH UPI ID. One Google Pay for Business app holds several
    // businesses — a live merchant runs four shops from one phone, each with its own UPI ID —
    // and the payment never names its destination. So the shop label the capture reports is
    // mapped to a UPI ID here, and credits inherit it (see lib/business-vpa.ts).
    business_vpas: z.array(z.object({
      marker: z.string().min(2).max(160),
      vpa: z.string().min(3).max(120),
    })).max(40).optional()
      .transform((v) => v && v.map((e) => ({ marker: e.marker.trim(), vpa: e.vpa.trim().toLowerCase() }))
        .filter((e) => e.marker && e.vpa)),
    env: z.enum(["SANDBOX", "PROD"]).optional(),
    notes: z.string().max(500).optional(),
  }).strict().optional(),
});

async function readConfig(code: string) {
  const r = await rows<any>("merchant",
    `SELECT enabled_methods, poolpay, COALESCE(blocked,false) AS blocked FROM merchant_payment_config WHERE merchant_code = $1`, [code]);
  if (!r.length) return { enabled_methods: DEFAULT_METHODS, poolpay: { enabled: false } as Record<string, unknown>, blocked: false };
  return { enabled_methods: r[0].enabled_methods ?? DEFAULT_METHODS, poolpay: r[0].poolpay ?? {}, blocked: r[0].blocked === true };
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  const scope = await resolveMerchantScope(id, g.session);
  if ("response" in scope) return scope.response;
  try {
    return NextResponse.json({ methods: METHODS, ...(await readConfig(scope.code)) });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  const scope = await resolveMerchantScope(id, g.session);
  if ("response" in scope) return scope.response;

  let body;
  try { body = patchSchema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const cur = await readConfig(scope.code);
    const enabled_methods = body.enabled_methods ?? cur.enabled_methods;
    const poolpay = body.poolpay ? { ...cur.poolpay, ...body.poolpay } : cur.poolpay;
    const blocked = body.blocked ?? cur.blocked;
    await rows("merchant", `
      INSERT INTO merchant_payment_config (merchant_code, enabled_methods, poolpay, blocked, updated_by, updated_at)
      VALUES ($1, $2::jsonb, $3::jsonb, $4, $5, now())
      ON CONFLICT (merchant_code) DO UPDATE
        SET enabled_methods = EXCLUDED.enabled_methods, poolpay = EXCLUDED.poolpay,
            blocked = EXCLUDED.blocked, updated_by = EXCLUDED.updated_by, updated_at = now()
    `, [scope.code, JSON.stringify(enabled_methods), JSON.stringify(poolpay), blocked, g.session.email]);
    return NextResponse.json({ methods: METHODS, enabled_methods, poolpay, blocked });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
