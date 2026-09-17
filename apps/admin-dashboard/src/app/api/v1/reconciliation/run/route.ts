// POST /api/v1/reconciliation/run — run a reconciliation pass (BRD §21, AC-007).
// Body (optional): { source, report: [{reference, amount_minor, utr}] }.

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { runReconciliation, type ReconSource } from "@/lib/fifo-recon";
import { runProviderPayoutRecon } from "@/lib/provider-payout-recon";

export const dynamic = "force-dynamic";

const schema = z.object({
  // PROVIDER_PAYOUT: every payout gateway's transfers vs Katana's payouts. <GATEWAY>_PAYOUT
  // narrows it to one gateway (PAYU_PAYOUT, RAZORPAY_PAYOUT, CASHFREE_PAYOUT, PAYTM_PAYOUT).
  source: z.enum(["LEDGER", "GATEWAY", "BANK", "USDT", "PROVIDER_PAYOUT", "PAYU_PAYOUT", "RAZORPAY_PAYOUT", "CASHFREE_PAYOUT", "PAYTM_PAYOUT"]).optional(),
  // Payout sources only: IST days, inclusive. Default: yesterday.
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  merchant_id: z.string().optional(),
  report: z.array(z.object({ reference: z.string(), amount_minor: z.union([z.number(), z.string()]), utr: z.string().optional() })).optional(),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "FINANCE"]);
  if ("response" in g) return g.response;
  let body: z.infer<typeof schema> = {};
  try { body = schema.parse(await req.json().catch(() => ({}))); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  try {
    if (body.source?.endsWith("_PAYOUT")) {
      const yesterday = new Date(Date.now() - 86_400_000);
      // Noon IST keeps the date on the intended day whatever the server's zone.
      const day = (s?: string) => (s ? new Date(`${s}T12:00:00+05:30`) : yesterday);
      const provider = body.source === "PROVIDER_PAYOUT" ? undefined : body.source.replace(/_PAYOUT$/, "");
      const r = await runProviderPayoutRecon({ from: day(body.from), to: day(body.to ?? body.from), merchantId: body.merchant_id, provider, createdBy: g.session.email });
      return NextResponse.json({ ok: true, ...r });
    }
    const r = await runReconciliation({ source: body.source as ReconSource | undefined, report: body.report, createdBy: g.session.email });
    return NextResponse.json({ ok: true, ...r });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
