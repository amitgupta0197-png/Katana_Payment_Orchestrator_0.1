// /api/usdt-rates — daily USDT settlement rate management (BRD §9).
//   GET  — current + recent rates per network. Readable by ADMIN / PROVIDER / MERCHANT
//          (the upline dashboard shows today's rate; the downline needs it to settle).
//   POST — declare a rate (SUPER_ADMIN only). The newest effective row per network wins;
//          a settlement locks the applicable rate at request creation.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

const USDT_NETWORKS = ["TRC20", "ERC20", "BEP20"] as const;

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  try {
    const list = await rows("provider", `
      SELECT id::text, network, market_rate::float AS market_rate, buy_rate::float AS buy_rate,
             sell_rate::float AS sell_rate, settlement_rate::float AS settlement_rate,
             katana_spread::float AS katana_spread, downline_spread::float AS downline_spread,
             network_fee::float AS network_fee, effective_from, expiry_at, created_by, approved_by, created_at
        FROM provider_usdt_rates
       ORDER BY effective_from DESC LIMIT 60
    `);
    // Current applicable rate per network = newest effective, not expired.
    const now = Date.now();
    const current: Record<string, unknown> = {};
    for (const r of list as Array<{ network: string; effective_from: string; expiry_at: string | null }>) {
      if (current[r.network]) continue;
      if (new Date(r.effective_from).getTime() <= now && (!r.expiry_at || new Date(r.expiry_at).getTime() > now))
        current[r.network] = r;
    }
    return NextResponse.json({ current, rates: list });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const createSchema = z.object({
  network: z.enum(USDT_NETWORKS),
  settlement_rate: z.coerce.number().positive(),
  market_rate: z.coerce.number().positive().nullish(),
  buy_rate: z.coerce.number().positive().nullish(),
  sell_rate: z.coerce.number().positive().nullish(),
  katana_spread: z.coerce.number().min(0).default(0),
  downline_spread: z.coerce.number().min(0).default(0),
  network_fee: z.coerce.number().min(0).default(0),
  expiry_at: z.string().datetime({ offset: true }).nullish(),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;

  let body: z.infer<typeof createSchema>;
  try { body = createSchema.parse(await req.json()); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }

  try {
    const ins = await rows<{ id: string }>("provider", `
      INSERT INTO provider_usdt_rates
        (network, market_rate, buy_rate, sell_rate, settlement_rate, katana_spread, downline_spread,
         network_fee, expiry_at, created_by, approved_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10,$10)
      RETURNING id::text
    `, [body.network, body.market_rate ?? null, body.buy_rate ?? null, body.sell_rate ?? null,
        body.settlement_rate, body.katana_spread, body.downline_spread, body.network_fee,
        body.expiry_at ?? null, s.email]);
    return NextResponse.json({ rate_id: ins[0].id });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
