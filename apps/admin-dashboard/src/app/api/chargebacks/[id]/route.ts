// One chargeback and its chain: banker event → original pay-in → rule → postings.
//
//   GET  /api/chargebacks/{id}   staff, or the merchant / banker whose banker it is (anything
//        else is "not found"). Merchants get the merchant view, without who did what at Katana.
//   POST /api/chargebacks/{id}   staff act on it:
//        { action: "link", order: "<order id | KTN id | Katana id>" }  match it by hand (never across channels)
//        { action: "reevaluate" }                                        try the match and the rule again
//        { action: "approve", note, amount? }   post the rule's debit, or a stated amount (Super Admin only), or 0
//        { action: "reverse", kind, note, amount? }  give a debit back, as a new linked entry
//        { action: "dismiss", note }            close a record that is not a chargeback (nothing debited)

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { PORTAL_PERSONAS, inScope, portalScope } from "@/lib/portal-scope";
import { CB_STAFF, REVERSAL_KINDS } from "@/lib/chargeback-rules";
import {
  approveChargeback, chargebackChain, chargebackProblems, ChargebackError, dismissChargeback, evaluateChargeback,
  getChargeback, reverseChargeback,
} from "@/lib/chargebacks-store";
import { merchantChain, merchantChargeback, staffChargeback } from "@/lib/chargeback-view";

export const dynamic = "force-dynamic";

const notFound = () => NextResponse.json({ error: "not found" }, { status: 404 });

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(PORTAL_PERSONAS);
  if ("response" in g) return g.response;
  const { id } = await params;
  try {
    const scope = await portalScope(g.session);
    const cb = await getChargeback(id);
    if (!cb || (!scope.staff && !inScope(scope, cb.merchant_id))) return notFound();
    const chain = await chargebackChain(id);
    const problems = chargebackProblems(cb);
    return NextResponse.json(scope.staff
      ? { chargeback: staffChargeback(cb, problems), ...chain }
      : { chargeback: merchantChargeback(cb, problems), ...merchantChain(chain.postings, chain.events) });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("link"), order: z.string().trim().min(1).max(120) }),
  z.object({ action: z.literal("reevaluate") }),
  z.object({ action: z.literal("approve"), note: z.string().trim().min(3).max(500), amount: z.coerce.number().min(0).nullish() }),
  z.object({ action: z.literal("reverse"), kind: z.enum(REVERSAL_KINDS), note: z.string().trim().min(3).max(500), amount: z.coerce.number().positive().nullish() }),
  z.object({ action: z.literal("dismiss"), note: z.string().trim().min(3).max(500) }),
]);

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse([...CB_STAFF]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;
  let a: z.infer<typeof action>;
  try { a = action.parse(await req.json()); } catch (e) {
    const msg = e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : "invalid JSON";
    return NextResponse.json({ error: msg, code: "INVALID_ACTION" }, { status: 400 });
  }
  // A debit not derived from the rule is a Super Admin's call, and it is recorded as one.
  if (a.action === "approve" && a.amount != null && a.amount > 0 && s.persona !== "SUPER_ADMIN") {
    return NextResponse.json({ error: "Only a Super Admin can post an amount the rule did not calculate.", code: "OVERRIDE_NOT_ALLOWED" }, { status: 403 });
  }
  try {
    const out =
      a.action === "link" ? await evaluateChargeback(id, s.email, a.order)
      : a.action === "reevaluate" ? await evaluateChargeback(id, s.email)
      : a.action === "approve" ? await approveChargeback(id, s.email, { amount: a.amount ?? null, note: a.note })
      : a.action === "reverse" ? await reverseChargeback(id, s.email, { kind: a.kind, amount: a.amount ?? null, note: a.note })
      : await dismissChargeback(id, s.email, a.note);
    if (!out) return notFound();
    return NextResponse.json({ chargeback: staffChargeback(out, chargebackProblems(out)), ...(await chargebackChain(id)) });
  } catch (err) {
    if (err instanceof ChargebackError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    const e = pgError(err); return NextResponse.json(e.body, { status: e.status });
  }
}
