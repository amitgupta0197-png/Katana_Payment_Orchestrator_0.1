// Banker-side chargebacks against Katana Pay pay-ins (lib/chargebacks-store).
//
//   GET  /api/chargebacks?channel=&state=&from=&to=&q=[&format=csv]
//        Staff see every chargeback; a merchant (PROVIDER) its bankers'; a banker (MERCHANT) its
//        own (lib/portal-scope). Merchants get the merchant view (lib/chargeback-view): no source
//        name, no person's note, no gateway name. `totals` is per channel for the window, with
//        `ratio`: chargebacks received per paid pay-in of that channel in the same window.
//   POST /api/chargebacks   { records: [ … ] } or one record — staff record what the bank,
//        acquirer or gateway reported. Each is matched to its pay-in inside the pay-in's channel
//        and ruled on at once; the same (source, bank_ref) twice is the same chargeback.

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError, rows } from "@/lib/pg";
import { txnConditions } from "@/lib/txn-window";
import { gateOrResponse } from "@/lib/scope";
import { getLivemode } from "@/lib/mode";
import { PORTAL_PERSONAS, portalScope } from "@/lib/portal-scope";
import { parsePayinChannel, PAYIN_CHANNELS } from "@/lib/payin-channel";
import { CB_SOURCES, CB_STAFF, CB_STATES } from "@/lib/chargeback-rules";
import {
  chargebackProblems, chargebackTotals, emptyCbTotals, ingestChargeback, listChargebacks, type ChargebackRow,
} from "@/lib/chargebacks-store";
import { merchantChargeback, staffChargeback, type MerchantChargeback } from "@/lib/chargeback-view";
import { csvResponse, datedFilename, toCsv, type CsvColumn } from "@/lib/csv";

export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request) {
  const g = await gateOrResponse(PORTAL_PERSONAS);
  if ("response" in g) return g.response;
  const s = g.session;
  const sp = new URL(req.url).searchParams;
  try {
    const scope = await portalScope(s);
    const state = (CB_STATES as readonly string[]).includes((sp.get("state") ?? "").toUpperCase()) ? sp.get("state")!.toUpperCase() : null;
    const filter = {
      codes: scope.codes, livemode: await getLivemode(),
      channel: parsePayinChannel(sp.get("channel")), state,
      from: DATE.test(sp.get("from") ?? "") ? sp.get("from") : null,
      to: DATE.test(sp.get("to") ?? "") ? sp.get("to") : null,
      q: sp.get("q")?.trim() || null,
    };
    const csv = sp.get("format") === "csv";
    const paidWindow = txnConditions("", { codes: scope.codes, from: filter.from, to: filter.to, status: null, livemode: filter.livemode },
      ["vendor = 'KATANA'", "status IN ('SUCCESS','SUCCEEDED')", ...(scope.codes ? [] : ["merchant_id IS NOT NULL"])]);
    const [list, totals, paid] = await Promise.all([
      listChargebacks({ ...filter, limit: csv ? 2000 : 300 }),
      chargebackTotals(filter),
      csv || (scope.codes && !scope.codes.length) ? Promise.resolve([]) : rows<{ channel_type: string; n: number }>("vendorGateway",
        `SELECT channel_type, COUNT(*)::int AS n FROM vendor_payin_orders ${paidWindow.where} GROUP BY 1`, paidWindow.args),
    ]);
    const view = (c: ChargebackRow) => (scope.staff ? staffChargeback : merchantChargeback)(c, chargebackProblems(c));
    const items = list.map(view);
    if (csv) return csvResponse(datedFilename("chargebacks"), toCsv(CSV_COLUMNS, items));
    const paidOf = (c: string) => paid.find((p) => p.channel_type === c)?.n ?? 0;
    const ratio = (count: number, n: number) => (n ? Math.round((count / n) * 10000) / 100 : null);
    const byChannel = Object.fromEntries(PAYIN_CHANNELS.map((c) => {
      const t = totals[c] ?? emptyCbTotals();
      return [c, { ...t, paid: paidOf(c), ratio: t.count ? ratio(t.count, paidOf(c)) : null }];
    }));
    return NextResponse.json({ chargebacks: items, totals: byChannel, staff: scope.staff });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

// Every export keeps the channel and the reconciliation state (design §15).
const CSV_COLUMNS: CsvColumn<MerchantChargeback>[] = [
  { header: "Chargeback", value: (r) => r.cb_ref },
  { header: "Received", value: (r) => r.received_at },
  { header: "Channel", value: (r) => r.channel ?? "" },
  { header: "Banker", value: (r) => r.banker ?? "" },
  { header: "Source", value: (r) => r.source },
  { header: "Bank reference", value: (r) => r.bank_ref, ref: true },
  { header: "Payment reference (UTR / RRN)", value: (r) => r.original_ref ?? r.order_utr ?? "", ref: true },
  { header: "Order", value: (r) => r.order_ref ?? "" },
  { header: "Order date", value: (r) => r.order_date ?? "" },
  { header: "Order amount", value: (r) => r.order_amount ?? "" },
  { header: "Chargeback amount", value: (r) => r.amount },
  { header: "Reason code", value: (r) => r.reason_code ?? "" },
  { header: "Reason", value: (r) => r.reason ?? "" },
  { header: "Debit ratio", value: (r) => r.debit_ratio ?? "" },
  { header: "Calculated debit", value: (r) => r.calculated_debit ?? "" },
  { header: "Debited", value: (r) => r.debited },
  { header: "Reversed", value: (r) => r.reversed },
  { header: "Net debited", value: (r) => r.net_debited },
  { header: "Remaining exposure", value: (r) => r.remaining_exposure },
  { header: "State", value: (r) => r.state },
  { header: "Reconciled", value: (r) => (r.reconciled ? "yes" : "no") },
];

const record = z.object({
  source: z.enum(CB_SOURCES),
  source_name: z.string().max(120).nullish(),
  bank_ref: z.string().trim().min(1).max(120),
  original_ref: z.string().trim().max(120).nullish(),
  order_ref: z.string().trim().max(120).nullish(),
  banker: z.string().trim().max(120).nullish(),
  channel: z.preprocess((v) => (typeof v === "string" && v.trim() ? v.trim().toUpperCase() : null), z.enum(["INTENT", "P2P"]).nullable()),
  amount: z.coerce.number().positive().max(100_000_000),
  currency: z.string().length(3).optional(),
  reason_code: z.string().trim().max(40).nullish(),
  reason_text: z.string().trim().max(500).nullish(),
  event_date: z.string().regex(DATE).nullish().or(z.literal("").transform(() => null)),
  livemode: z.boolean().optional(),
}).refine((r) => r.original_ref || r.order_ref, { message: "a payment reference (UTR / RRN) or an order id is required" });

const body = z.union([z.object({ records: z.array(record).min(1).max(500) }), record.transform((r) => ({ records: [r] }))]);

export async function POST(req: Request) {
  const g = await gateOrResponse([...CB_STAFF]);
  if ("response" in g) return g.response;
  const s = g.session;
  let parsed: z.infer<typeof body>;
  try { parsed = body.parse(await req.json()); } catch (e) {
    const msg = e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".") || "record"}: ${i.message}`).join("; ") : "invalid JSON";
    return NextResponse.json({ error: msg, code: "INVALID_RECORD" }, { status: 400 });
  }
  try {
    // A record is in the mode the dashboard is in unless it says otherwise.
    const livemode = await getLivemode();
    const results = [];
    for (const r of parsed.records) {
      try {
        const out = await ingestChargeback({ ...r, livemode: r.livemode ?? livemode }, s.email);
        results.push({ bank_ref: r.bank_ref, created: out.created, chargeback: staffChargeback(out.chargeback, chargebackProblems(out.chargeback)) });
      } catch (e) {
        results.push({ bank_ref: r.bank_ref, created: false, error: (e as Error).message });
      }
    }
    return NextResponse.json({ results }, { status: results.some((x) => x.created) ? 201 : 200 });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
