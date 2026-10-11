// A banker's one P2P method: UPI ID, BharatPe or PayAtom (merchant 0027, lib/p2p-method).
//
//   GET  SUPER_ADMIN, ADMIN, OPERATOR   chosen method, the one routing uses today when none is
//                                       chosen, what each method has set up, history
//   PUT  SUPER_ADMIN, ADMIN             { method: "UPI_ID" | "BHARATPE" | "PAYATOM" | null, note? }
//
// Staff only: it names the processors.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { inferP2pMethod, P2P_METHODS, p2pSteps } from "@/lib/p2p-method";
import { getP2pMethod, p2pFacts, p2pMethodHistory, setP2pMethod } from "@/lib/p2p-method-store";
import { wormAppend } from "@/lib/worm";

export const dynamic = "force-dynamic";

const schema = z.object({
  method: z.enum(["UPI_ID", "BHARATPE", "PAYATOM"]).nullable(),
  note: z.string().trim().max(300).optional(),
});

async function bankerCode(id: string): Promise<string | null> {
  const m = await rows<{ merchant_code: string }>("merchant",
    `SELECT merchant_code FROM merchants WHERE id::text = $1 OR merchant_code = $1 LIMIT 1`, [id]).catch(() => []);
  return m[0]?.merchant_code ?? null;
}

async function state(code: string) {
  const [method, facts, history] = await Promise.all([getP2pMethod(code), p2pFacts(code), p2pMethodHistory(code)]);
  return {
    method,
    inferred: inferP2pMethod(facts),
    facts,
    methods: Object.fromEntries(P2P_METHODS.map((m) => [m, p2pSteps(m, facts)])),
    history,
  };
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "OPERATOR"]);
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
    const before = await getP2pMethod(code);
    const r = await setP2pMethod(code, { value: body.method, by: g.session.email, note: body.note });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 404 });
    if (before !== body.method) {
      wormAppend({
        actorId: g.session.user_id, actorEmail: g.session.email, action: "merchant.p2p_method",
        resourceType: "merchant", resourceId: code, before: { p2p_method: before }, after: { p2p_method: body.method },
        notes: body.note || undefined,
      }).catch(() => {});
    }
    return NextResponse.json(await state(code));
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
