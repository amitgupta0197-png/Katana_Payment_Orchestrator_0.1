// Money paid straight to a banker's UPI ID, as rows of the merchant's Transactions list and CSV
// (/api/merchant-portal/transactions and its export).
//
// Most P2P money comes with no order: the customer pays the banker's UPI ID and the collection
// phone reports the credit (vendor_txn_alerts). The banker's own Transactions page has always
// listed these; the merchant's counted orders only, so its tiles read zero while money came in.
//
// Only credits NO order accounts for are returned: one linked to an order (outcome CONFIRMED, or a
// matched_order_id) is already in the list as that order, and adding it would count it twice.
// Collections only (lib/settlement-credit), live only: a credit is real money, and a test-mode
// screen has none. Status: a 12-digit bank reference proves it (SUCCESS); without one, or paid to a
// UPI ID that is not the banker's, it is not counted as collected yet (PENDING), as on the banker page.

import { rows } from "@/lib/pg";
import { IS_COLLECTION } from "@/lib/settlement-credit";
import { vpasFromConfig } from "@/lib/settlement-vpa";
import { verificationOf } from "@/lib/credit-verification";
import { IST_DAY_END, IST_DAY_START, type TxnWindow } from "@/lib/txn-window";
import { P2P_CHANNEL_ID, type PayinChannel } from "@/lib/payin-channel";

export interface CreditTxn {
  source: "UPI_CREDIT";
  merchant_id: string;
  channel: string;
  method: string;
  status: "SUCCESS" | "PENDING";
  amount: number;
  /** The bank reference (UTR) when there is one, else the credit's id. */
  ref: string;
  created_at: string;
  channel_type: PayinChannel;
  utr: string | null;
  payer_vpa: string | null;
}

interface Alert {
  id: string; merchant_id: string | null; amount: number; utr: string | null; payer_vpa: string | null;
  payee_vpa: string | null; outcome: string | null; at: string;
}

export async function unlinkedCredits(w: TxnWindow, limit = 2000): Promise<CreditTxn[]> {
  if (!w.livemode) return [];
  if (w.channel && w.channel !== "P2P") return [];
  if (w.codes && !w.codes.length) return [];

  // Each banker's UPI IDs: an untagged credit is attributed by the one it was paid to, and a
  // credit paid to none of its banker's is not proven (lib/credit-verification).
  const cfg = w.codes ? await rows<{ code: string; katana_pay: unknown }>("merchant",
    `SELECT merchant_code AS code, katana_pay FROM merchant_payment_config WHERE merchant_code = ANY($1::text[])`,
    [w.codes]).catch((e) => { console.warn("[merchant-credits] config:", (e as Error).message); return []; }) : [];
  const vpasOf = new Map(cfg.map((c) => [c.code, vpasFromConfig(c.katana_pay)]));
  const ownerOfVpa = new Map<string, string>();
  for (const [code, vpas] of vpasOf) for (const v of vpas) if (!ownerOfVpa.has(v.toLowerCase())) ownerOfVpa.set(v.toLowerCase(), code);

  const args: unknown[] = [];
  const cond = [`direction = 'CREDIT'`, IS_COLLECTION, `livemode = true`, `matched_order_id IS NULL`, `COALESCE(outcome, '') <> 'CONFIRMED'`];
  if (w.codes) {
    args.push(w.codes); const c = `$${args.length}`;
    args.push([...ownerOfVpa.keys()].length ? [...ownerOfVpa.keys()] : ["__none__"]); const v = `$${args.length}`;
    cond.push(`(merchant_id = ANY(${c}::text[]) OR (merchant_id IS NULL AND lower(payee_vpa) = ANY(${v}::text[])))`);
  } else cond.push(`merchant_id IS NOT NULL`);
  // The day the money arrived, not the moment the phone reported it.
  if (w.from) { args.push(w.from); cond.push(`COALESCE(event_time, created_at) >= ${IST_DAY_START(`$${args.length}`)}`); }
  if (w.to) { args.push(w.to); cond.push(`COALESCE(event_time, created_at) < ${IST_DAY_END(`$${args.length}`)}`); }

  const alerts = await rows<Alert>("vendorGateway", `
    SELECT id::text, merchant_id, COALESCE(amount, 0)::float AS amount, utr, payer_vpa, payee_vpa, outcome,
           COALESCE(event_time, created_at) AS at
      FROM vendor_txn_alerts
     WHERE ${cond.join(" AND ")}
     ORDER BY COALESCE(event_time, created_at) DESC
     LIMIT ${Math.max(1, Math.min(limit, 10_000))}
  `, args).catch((e) => { console.warn("[merchant-credits] alerts:", (e as Error).message); return []; });

  const out: CreditTxn[] = alerts.map((a) => {
    const code = a.merchant_id ?? ownerOfVpa.get((a.payee_vpa ?? "").toLowerCase()) ?? "—";
    const v = verificationOf(a, vpasOf.get(code) ?? []);
    return {
      source: "UPI_CREDIT", merchant_id: code, channel: P2P_CHANNEL_ID, method: "UPI",
      status: v === "verified" || v === "matched" ? "SUCCESS" : "PENDING",
      amount: Number(a.amount) || 0, ref: a.utr || a.id, created_at: new Date(a.at).toISOString(),
      channel_type: "P2P", utr: a.utr, payer_vpa: a.payer_vpa,
    };
  });
  return w.status ? out.filter((r) => r.status === w.status!.toUpperCase()) : out;
}
