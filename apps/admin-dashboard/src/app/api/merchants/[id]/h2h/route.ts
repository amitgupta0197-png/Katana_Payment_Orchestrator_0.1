// A banker's own choice of host-to-host (H2H) or redirect for its Intent checkout (merchant 0026,
// lib/checkout-mode-store). It wins over its merchant's (providers.needs_h2h); null follows it.
//
//   GET  SUPER_ADMIN, ADMIN    the banker's own choice, its merchant's, the one in force, history
//   PUT  SUPER_ADMIN, ADMIN    { needs_h2h: true | false | null, note? }

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { bankerH2hHistory, getBankerH2h, setBankerNeedsH2h } from "@/lib/checkout-mode-store";

export const dynamic = "force-dynamic";

const schema = z.object({
  needs_h2h: z.boolean().nullable(),
  note: z.string().trim().max(300).optional(),
});

async function bankerCode(id: string): Promise<string | null> {
  const m = await rows<{ merchant_code: string }>("merchant", `SELECT merchant_code FROM merchants WHERE id = $1::uuid`, [id]).catch(() => []);
  return m[0]?.merchant_code ?? null;
}

async function state(code: string) {
  const [h, history] = await Promise.all([getBankerH2h(code), bankerH2hHistory(code)]);
  return { needs_h2h: h.own, merchant_needs_h2h: h.merchant, merchant_chosen: h.merchant_chosen, effective: h.effective, provider_id: h.provider_id, history };
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN"]);
  if ("response" in g) return g.response;
  const code = await bankerCode((await params).id);
  if (!code) return NextResponse.json({ error: "banker not found" }, { status: 404 });
  try { return NextResponse.json(await state(code)); }
  catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN"]);
  if ("response" in g) return g.response;
  const code = await bankerCode((await params).id);
  if (!code) return NextResponse.json({ error: "banker not found" }, { status: 404 });
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const r = await setBankerNeedsH2h(code, { value: body.needs_h2h, by: g.session.email, note: body.note });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 404 });
    return NextResponse.json(await state(code));
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
