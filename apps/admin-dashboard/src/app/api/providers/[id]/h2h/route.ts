// Whether one merchant (a `providers` row) needs host-to-host checkout (provider 0023,
// lib/checkout-mode-store). Its bankers may then not be given a redirect-only payment account.
//
//   GET  SUPER_ADMIN, ADMIN    the setting and its change history
//   PUT  SUPER_ADMIN, ADMIN    switch it on or off

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { getProviderNeedsH2h, providerH2hHistory, setProviderNeedsH2h } from "@/lib/checkout-mode-store";

export const dynamic = "force-dynamic";

const schema = z.object({
  needs_h2h: z.boolean(),
  note: z.string().trim().max(300).optional(),
});

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  try {
    const [needs_h2h, history] = await Promise.all([getProviderNeedsH2h(id), providerH2hHistory(id)]);
    return NextResponse.json({ needs_h2h, history });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const r = await setProviderNeedsH2h(id, { value: body.needs_h2h, by: g.session.email, note: body.note });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.error === "merchant not found" ? 404 : 400 });
    return NextResponse.json({ needs_h2h: r.value, history: await providerH2hHistory(id) });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
