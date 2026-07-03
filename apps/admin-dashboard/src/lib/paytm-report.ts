// Paytm for Business transaction/settlement report (CSV) parser.
//
// Merchants without API access reconcile via this downloadable report. Unlike the
// real-time email (amount + Order ID, no RRN), the report carries the actual per-txn
// **RRN** for every row, keyed by the same Order ID the email gives — so it backfills
// the RRN onto records the email/notification already created (matched by Order ID).
//
// Paytm's CSV quotes text fields with a leading apostrophe (e.g. 'PTM…', "'2026…'") to
// force Excel to treat them as text; we strip that. Key columns: Order_ID, Amount,
// Status, Transaction_Type, RRN (per-txn UPI RRN), UTR_No. (bank settlement UTR),
// Customer_VPA (full, unmasked), Transaction_Date, Transaction_ID.

export interface PaytmReportRow {
  txnId: string;
  orderRef: string;      // Paytm Order ID — matches the email's Order ID
  amount: number;
  rrn: string;           // per-transaction UPI RRN (12-digit)
  utr: string | null;    // bank settlement UTR (batch-level)
  payerVpa: string | null;
  status: string;
  paymentMode: string | null;
  txnDate: string | null;
}

// Strip Paytm's Excel-guard quoting: surrounding double-quotes and a leading apostrophe.
function clean(s: string | undefined): string {
  return (s ?? "").replace(/^"/, "").replace(/"$/, "").replace(/^'/, "").replace(/'$/, "").trim();
}

// Quote-aware split of one CSV line (respects "..." fields).
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; cur += c; }
    else if (c === "," && !inQ) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

export interface ParsePaytmReportResult {
  rows: PaytmReportRow[];
  total: number;        // data rows seen
  skipped: number;      // rows dropped (not SUCCESS credit / no RRN / no Order ID)
}

// Parse a Paytm report CSV. Keeps only successful acquiring (credit) rows that carry
// both an Order ID and an RRN — the ones we can backfill.
export function parsePaytmReport(csv: string): ParsePaytmReportResult {
  const lines = (csv ?? "").split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return { rows: [], total: 0, skipped: 0 };

  const header = splitCsvLine(lines[0]).map(clean);
  const col = (name: string) => header.indexOf(name);
  const iOrder = col("Order_ID"), iAmount = col("Amount"), iStatus = col("Status");
  const iType = col("Transaction_Type"), iRrn = col("RRN"), iUtr = col("UTR_No.");
  const iVpa = col("Customer_VPA"), iDate = col("Transaction_Date");
  const iTxn = col("Transaction_ID"), iMode = col("Payment_Mode");
  if (iOrder < 0 || iRrn < 0) return { rows: [], total: 0, skipped: 0 }; // not a Paytm report

  const rows: PaytmReportRow[] = [];
  let total = 0, skipped = 0;
  for (let i = 1; i < lines.length; i++) {
    const f = splitCsvLine(lines[i]).map(clean);
    total++;
    const status = (f[iStatus] ?? "").toUpperCase();
    const type = (f[iType] ?? "").toUpperCase();
    const orderRef = f[iOrder] ?? "";
    const rrn = f[iRrn] ?? "";
    const amount = parseFloat((f[iAmount] ?? "").replace(/,/g, ""));
    // Keep only successful credits (ACQUIRING) that carry an Order ID + RRN + amount.
    if (status !== "SUCCESS" || (iType >= 0 && type && type !== "ACQUIRING") ||
        !orderRef || !rrn || !Number.isFinite(amount) || amount <= 0) { skipped++; continue; }
    rows.push({
      txnId: f[iTxn] ?? "",
      orderRef,
      amount,
      rrn,
      utr: (iUtr >= 0 && f[iUtr]) ? f[iUtr] : null,
      payerVpa: (iVpa >= 0 && f[iVpa]) ? f[iVpa] : null,
      status,
      paymentMode: (iMode >= 0 && f[iMode]) ? f[iMode] : null,
      txnDate: (iDate >= 0 && f[iDate]) ? f[iDate] : null,
    });
  }
  return { rows, total, skipped };
}
