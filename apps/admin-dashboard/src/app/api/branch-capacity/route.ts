// /api/branch-capacity — the downline's self-declared settlement capacity (BRD §14):
// bank/USDT availability, declared USDT quantity + network, daily ₹ capacity, and a
// temporary-unavailability window.
//   GET  — MERCHANT: own row. SUPER_ADMIN: all rows (or ?branch=). PROVIDER: rows for
//          its mapped branches (so the upline sees capacity when raising).
//   POST — upsert own declaration. MERCHANT + SUPER_ADMIN (?branch= for admin).

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { branchKeysForMerchant, branchKeysForProvider } from "@/lib/provider-integration";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const url = new URL(req.url);

  try {
    let where = ""; const args: unknown[] = [];
    if (s.persona === "MERCHANT") {
      args.push(await branchKeysForMerchant(s.scope_id!)); where = `WHERE merchant_key = ANY($1::text[])`;
    } else if (s.persona === "PROVIDER") {
      const keys = await branchKeysForProvider(s.scope_id!);
      args.push(keys.length ? keys : ["__none__"]); where = `WHERE merchant_key = ANY($1::text[])`;
    } else if (url.searchParams.get("branch")) {
      args.push(url.searchParams.get("branch")); where = `WHERE merchant_key = $1`;
    }
    const list = await rows("provider", `
      SELECT merchant_key, bank_available, usdt_available, usdt_quantity::float AS usdt_quantity,
             usdt_network, daily_capacity::float AS daily_capacity, unavailable_until, note,
             updated_by, updated_at
        FROM provider_branch_capacity ${where} ORDER BY updated_at DESC LIMIT 200
    `, args);
    return NextResponse.json({ capacity: list });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const schema = z.object({
  branch: z.string().max(120).optional(),       // SUPER_ADMIN only; MERCHANT uses own scope
  bank_available: z.boolean().default(true),
  usdt_available: z.boolean().default(false),
  usdt_quantity: z.coerce.number().min(0).nullish(),
  usdt_network: z.enum(["TRC20", "ERC20", "BEP20"]).nullish(),
  daily_capacity: z.coerce.number().min(0).nullish(),
  unavailable_until: z.string().datetime({ offset: true }).nullish(),
  note: z.string().max(300).nullish(),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;

  let body: z.infer<typeof schema>;
  try { body = schema.parse(await req.json()); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }

  // The branch key the declaration is stored under: the merchant's canonical code.
  let key: string;
  if (s.persona === "MERCHANT") {
    const keys = await branchKeysForMerchant(s.scope_id!);
    key = keys[keys.length - 1] ?? s.scope_id!;   // merchant_code when resolvable
  } else {
    if (!body.branch) return NextResponse.json({ error: "branch required for admin" }, { status: 400 });
    key = body.branch;
  }

  try {
    await rows("provider", `
      INSERT INTO provider_branch_capacity
        (merchant_key, bank_available, usdt_available, usdt_quantity, usdt_network, daily_capacity, unavailable_until, note, updated_by, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8,$9, now())
      ON CONFLICT (merchant_key) DO UPDATE SET
        bank_available = EXCLUDED.bank_available, usdt_available = EXCLUDED.usdt_available,
        usdt_quantity = EXCLUDED.usdt_quantity, usdt_network = EXCLUDED.usdt_network,
        daily_capacity = EXCLUDED.daily_capacity, unavailable_until = EXCLUDED.unavailable_until,
        note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()
    `, [key, body.bank_available, body.usdt_available, body.usdt_quantity ?? null, body.usdt_network ?? null,
        body.daily_capacity ?? null, body.unavailable_until ?? null, body.note ?? null, s.email]);
    return NextResponse.json({ ok: true, branch: key });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
