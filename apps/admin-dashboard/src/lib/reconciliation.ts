// Three-way reconciliation (BRD §11 P7).
//
//   Level 1: exact match by provider_txn_id / order_id / UTR / TXID
//   Level 2: match by amount_minor + currency + settlement_date + merchant_id
//   Level 3: fuzzy match within tolerance window
//   Unmatched → recon_break with ageing bucket 0-24h / 1-3d / 3-7d / 7d+
//
// Sources:
//   - internal: checkoutservice_db.checkout_orders (status=SUCCESS in window)
//   - partner:  settlementservice_db.settlement_partner_records
//   - ledger:   ledgerservice_db.journal_entries (journal_type='payment.success')
//
// Run is idempotent within a window: re-running upserts breaks rather than
// duplicating.

import { rows } from "@/lib/pg";

export interface RunInput {
  windowStart: Date;
  windowEnd: Date;
  toleranceMinor?: bigint;     // for level-3 fuzzy
  toleranceMinutes?: number;
}

export interface RunResult {
  run_id: string;
  items_total: number;
  matched_3way: number;
  matched_2way: number;
  matched_fuzzy: number;
  breaks_opened: number;
}

function ageingBucket(openedAt: Date): "0-24h" | "1-3d" | "3-7d" | "7d+" {
  const ageMs = Date.now() - openedAt.getTime();
  const hours = ageMs / (1000 * 60 * 60);
  if (hours < 24) return "0-24h";
  if (hours < 72) return "1-3d";
  if (hours < 168) return "3-7d";
  return "7d+";
}

interface InternalRow { txn_id: string; merchant_id: string; amount_minor: string | null; currency: string; created_at: string }
interface PartnerRow  { pay_id: string; vendor: string; vendor_txn_id: string | null; amount: string; currency_code: string; created_at: string }
interface LedgerRow   { id: string; ref_id: string; total_debit_minor: string; currency: string; posted_at: string; merchant_id: string | null }

const TOLERANCE_MINOR_DEFAULT = 100n;       // ₹1.00 in INR minor units
const TOLERANCE_MINUTES_DEFAULT = 30;

export async function runReconciliation(input: RunInput): Promise<RunResult> {
  const tolMinor = input.toleranceMinor ?? TOLERANCE_MINOR_DEFAULT;
  const tolMinutes = input.toleranceMinutes ?? TOLERANCE_MINUTES_DEFAULT;

  const start = input.windowStart.toISOString();
  const end = input.windowEnd.toISOString();

  const run = await rows<{ id: string }>("reconciliation", `
    INSERT INTO recon_runs (tenant_id, window_start, window_end, status, started_at)
    VALUES ('tenant-default', $1, $2, 'RUNNING', now())
    RETURNING id::text
  `, [start, end]);
  const runId = run[0].id;

  // 1. Load all three sources for the window.
  const internal = await rows<InternalRow>("checkout", `
    SELECT txn_id, merchant_id, amount_minor::text, currency, created_at
      FROM checkout_orders
     WHERE status = 'SUCCESS' AND created_at >= $1 AND created_at < $2
  `, [start, end]).catch(() => []);
  const partner = await rows<PartnerRow>("vendorGateway", `
    SELECT pay_id, vendor, COALESCE(vendor_txn_id,'') AS vendor_txn_id,
           amount::text, currency_code, created_at
      FROM vendor_payin_orders
     WHERE created_at >= $1 AND created_at < $2
  `, [start, end]).catch(() => []);
  const ledger = await rows<LedgerRow>("ledger", `
    SELECT id::text, COALESCE(ref_id,'') AS ref_id,
           total_debit_minor::text, currency,
           posted_at, merchant_id
      FROM journal_entries
     WHERE journal_type='payment.success'
       AND posted_at >= $1 AND posted_at < $2
  `, [start, end]).catch(() => []);

  // Index helpers.
  const partnerByRef = new Map<string, PartnerRow>();
  for (const p of partner) {
    if (p.vendor_txn_id) partnerByRef.set(p.vendor_txn_id, p);
    if (p.pay_id) partnerByRef.set(p.pay_id, p);
  }
  const ledgerByRef = new Map<string, LedgerRow>();
  for (const l of ledger) if (l.ref_id) ledgerByRef.set(l.ref_id, l);

  // Track partner / ledger rows we've consumed so we can detect orphans.
  const consumedPartner = new Set<string>();
  const consumedLedger = new Set<string>();

  let matched3 = 0, matched2 = 0, matchedFuzzy = 0, breaksOpened = 0;

  // 2. Iterate internal SUCCESS orders.
  for (const i of internal) {
    const ref = i.txn_id;
    const amountMinor = BigInt(i.amount_minor ?? "0");

    // Level 1: exact-ref against ledger and partner.
    const lHit = ledgerByRef.get(ref);
    const pHit = partnerByRef.get(ref);
    if (lHit && pHit) {
      matched3 += 1;
      consumedLedger.add(lHit.id); consumedPartner.add(pHit.pay_id);
      await rows("reconciliation", `
        INSERT INTO recon_matches
          (run_id, tenant_id, reference, amount, currency, kind, internal_id, match_level)
        VALUES ($1::uuid, 'tenant-default', $2, $3, $4, '3WAY', NULL, 1)
        ON CONFLICT DO NOTHING
      `, [runId, ref, amountMinor.toString(), i.currency]).catch(() => null);
      continue;
    }

    // Level 2: tolerance on amount/date/merchant.
    let level2: { partner?: PartnerRow; ledger?: LedgerRow } | null = null;
    for (const p of partner) {
      if (consumedPartner.has(p.pay_id)) continue;
      if (p.currency_code !== i.currency) continue;
      const pAmt = BigInt(Math.round(Number(p.amount) * Math.pow(10, i.currency === "JPY" ? 0 : 2)));
      if (absDiff(pAmt, amountMinor) > tolMinor) continue;
      if (Math.abs(timeDiffMinutes(p.created_at, i.created_at)) > tolMinutes) continue;
      level2 = { partner: p }; break;
    }
    for (const l of ledger) {
      if (consumedLedger.has(l.id)) continue;
      if (l.currency !== i.currency) continue;
      if (l.merchant_id && l.merchant_id !== i.merchant_id) continue;
      if (absDiff(BigInt(l.total_debit_minor), amountMinor) > tolMinor) continue;
      if (Math.abs(timeDiffMinutes(l.posted_at, i.created_at)) > tolMinutes) continue;
      level2 = { ...(level2 ?? {}), ledger: l }; break;
    }
    if (level2?.partner && level2.ledger) {
      matched2 += 1;
      consumedPartner.add(level2.partner.pay_id);
      consumedLedger.add(level2.ledger.id);
      await rows("reconciliation", `
        INSERT INTO recon_matches
          (run_id, tenant_id, reference, amount, currency, kind, internal_id, match_level)
        VALUES ($1::uuid, 'tenant-default', $2, $3, $4, '3WAY', NULL, 2)
        ON CONFLICT DO NOTHING
      `, [runId, ref, amountMinor.toString(), i.currency]).catch(() => null);
      continue;
    }

    // Level 3: fuzzy — any single side within tolerance.
    if (level2?.partner || level2?.ledger) {
      matchedFuzzy += 1;
      if (level2.partner) consumedPartner.add(level2.partner.pay_id);
      if (level2.ledger) consumedLedger.add(level2.ledger.id);
      await rows("reconciliation", `
        INSERT INTO recon_matches
          (run_id, tenant_id, reference, amount, currency, kind, internal_id, match_level)
        VALUES ($1::uuid, 'tenant-default', $2, $3, $4, '2WAY', NULL, 3)
        ON CONFLICT DO NOTHING
      `, [runId, ref, amountMinor.toString(), i.currency]).catch(() => null);
      continue;
    }

    // Unmatched → break.
    const ageing = ageingBucket(new Date(i.created_at));
    const sources = !lHit && !pHit ? "INTERNAL_ONLY" : !lHit ? "INTERNAL+PARTNER" : "INTERNAL+LEDGER";
    const breakType = !lHit && !pHit ? "ORPHAN_INTERNAL" : "PARTIAL_MATCH";
    const expectedAction =
      !lHit ? "post missing journal" :
      !pHit ? "request partner record" :
      "investigate";
    await rows("reconciliation", `
      INSERT INTO recon_breaks
        (run_id, tenant_id, reference, break_type, sources_present, amount, currency,
         status, ageing_bucket, expected_action, evidence)
      VALUES ($1::uuid, 'tenant-default', $2, $3, $4, $5, $6, 'OPEN', $7, $8, $9::jsonb)
      ON CONFLICT (tenant_id, reference, break_type, currency) DO UPDATE
        SET run_id=EXCLUDED.run_id, ageing_bucket=EXCLUDED.ageing_bucket,
            evidence=EXCLUDED.evidence, sources_present=EXCLUDED.sources_present
    `, [runId, ref, breakType, sources,
        amountMinor.toString(), i.currency,
        ageing, expectedAction,
        JSON.stringify({ internal_created_at: i.created_at, merchant_id: i.merchant_id })]).catch(() => null);
    breaksOpened += 1;
  }

  // Orphan partner / ledger rows — what we saw on the partner side but
  // not on ours, or in our ledger but with no internal order.
  for (const p of partner) {
    if (consumedPartner.has(p.pay_id)) continue;
    const ageing = ageingBucket(new Date(p.created_at));
    await rows("reconciliation", `
      INSERT INTO recon_breaks
        (run_id, tenant_id, reference, break_type, sources_present, amount, currency,
         status, ageing_bucket, expected_action, evidence)
      VALUES ($1::uuid, 'tenant-default', $2, 'ORPHAN_PARTNER', 'PARTNER_ONLY',
              $3, $4, 'OPEN', $5, 'investigate ghost partner record', $6::jsonb)
      ON CONFLICT (tenant_id, reference, break_type, currency) DO UPDATE
        SET run_id=EXCLUDED.run_id, ageing_bucket=EXCLUDED.ageing_bucket,
            sources_present=EXCLUDED.sources_present
    `, [runId, p.vendor_txn_id || p.pay_id, p.amount, p.currency_code, ageing,
        JSON.stringify({ vendor: p.vendor, pay_id: p.pay_id })]).catch(() => null);
    breaksOpened += 1;
  }
  for (const l of ledger) {
    if (consumedLedger.has(l.id) || !l.ref_id) continue;
    const ageing = ageingBucket(new Date(l.posted_at));
    await rows("reconciliation", `
      INSERT INTO recon_breaks
        (run_id, tenant_id, reference, break_type, sources_present, amount, currency,
         status, ageing_bucket, expected_action, evidence)
      VALUES ($1::uuid, 'tenant-default', $2, 'ORPHAN_LEDGER', 'LEDGER_ONLY',
              $3, $4, 'OPEN', $5, 'find originating internal txn', $6::jsonb)
      ON CONFLICT (tenant_id, reference, break_type, currency) DO UPDATE
        SET run_id=EXCLUDED.run_id, ageing_bucket=EXCLUDED.ageing_bucket,
            sources_present=EXCLUDED.sources_present
    `, [runId, l.ref_id, l.total_debit_minor, l.currency, ageing,
        JSON.stringify({ journal_id: l.id, posted_at: l.posted_at })]).catch(() => null);
    breaksOpened += 1;
  }

  const itemsTotal = internal.length + partner.length + ledger.length;
  await rows("reconciliation", `
    UPDATE recon_runs SET status='COMPLETED', completed_at=now(),
                          items_total=$1, matched_3way=$2, matched_2way=$3, breaks_opened=$4
     WHERE id=$5::uuid
  `, [itemsTotal, matched3, matched2 + matchedFuzzy, breaksOpened, runId]);

  return {
    run_id: runId, items_total: itemsTotal,
    matched_3way: matched3, matched_2way: matched2, matched_fuzzy: matchedFuzzy,
    breaks_opened: breaksOpened,
  };
}

function absDiff(a: bigint, b: bigint): bigint { return a > b ? a - b : b - a; }
function timeDiffMinutes(a: string, b: string): number {
  return (new Date(a).getTime() - new Date(b).getTime()) / 60000;
}
