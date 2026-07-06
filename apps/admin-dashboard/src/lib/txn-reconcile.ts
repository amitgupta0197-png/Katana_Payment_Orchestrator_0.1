// Transaction Intelligence — bank-credit alert ingestion, forensic checks, and
// reconciliation (per "SMS Transaction Reconciliation & Forensic Security
// Architecture", §3 Level-1 DFD and §6 Reconciliation Logic).
//
// Pipeline for one CREDIT alert:
//   1) OTP / auth-message guard  — never store or act on OTP/PIN/password messages.
//   2) Raw event storage         — append-only, with a content hash (forensics §4).
//   3) Duplicate detection       — same message hash / nonce replay → DUPLICATE.
//   4) Device trust              — only TRUSTED enrolled devices may auto-confirm.
//   5) Order matching            — UTR → amount + payee VPA + recency (confidence).
//   6) Auto-match policy (§6)    — confidence >= 90 AND device TRUSTED AND no dup
//                                  → CONFIRMED, else create a MANUAL_CASE.
//   7) Forensics                 — fake-sender / suspicious-device / replay raise a
//                                  SECURITY_ALERT; every decision writes an audit row.
//
// Final design principle (§9): SMS is only a signal — confirmation requires a
// registered+trusted device, amount/account/time/reference match, no replay/dup, and
// confidence above the policy threshold.

import { createHash } from "crypto";
import { rows } from "@/lib/pg";
import { confirmPoolPayOrder, type ConfirmPoolPayResult } from "@/lib/poolpay-order";

// Policy knobs (architecture §6 / §8).
const CONFIDENCE_THRESHOLD = 90;      // auto-confirm bar
const MATCH_WINDOW_MIN = 30;          // order recency window for matching
const DEDUP_HASH_HOURS = 24;          // same message hash within this = duplicate
const NONCE_WINDOW_HOURS = 24;        // nonce reuse within this = replay
const REPLAY_SKEW_SECONDS = 300;      // ±5 min timestamp tolerance (signed mode)

export type ManualReason =
  | "LOW_CONFIDENCE" | "AMBIGUOUS" | "UNMATCHED" | "DUPLICATE"
  | "UNTRUSTED_DEVICE" | "SUSPICIOUS_DEVICE" | "AMOUNT_CONFLICT";

export interface TxnAlertInput {
  source?: string;        // DEVICE | SMS | NOTIFICATION | BANK_API | SIMULATED
  device_id?: string;
  merchant_id?: string;   // merchant the forwarder device belongs to
  bank?: string;
  sender?: string;        // SMS header / notification package
  direction?: string;     // CREDIT (default) | DEBIT
  amount: number | string;
  utr?: string;
  order_ref?: string;     // our order id parsed from the alert (e.g. Paytm email "Order ID: KP-…")
  payer_vpa?: string;
  payer_name?: string;    // payer's name from a push notification (no UTR/VPA path)
  payee_vpa?: string;
  narration?: string;
  raw?: string;
  event_time?: string;
  nonce?: string;
  parser_version?: string;
  sim_id?: string;
  app_hash?: string;
}

export interface TxnAlertResult {
  alert_id: string | null;
  outcome: "CONFIRMED" | "UNMATCHED" | "AMBIGUOUS" | "DUPLICATE" | "REJECTED";
  confidence: number;
  matched_order_ref: string | null;
  device_status: string;
  manual_case_id?: string;
  security_alert_id?: string;
  detail: string;
  confirm?: ConfirmPoolPayResult;
}

interface Cand { id: string; order_id: string; status: string; receiver_vpa: string; created_at: string }

// ── Forensic helpers ──────────────────────────────────────────────────────────────

// OTP / authentication messages must never be ingested (architecture §1, §8, §3.1).
const AUTH_RE = /\b(otp|one[\s-]?time\s*password|verification code|login code|do not share|don'?t share|pin\b|password|passcode|cvv|secure code)\b/i;
export function isAuthMessage(text: string | null | undefined): boolean {
  return !!text && AUTH_RE.test(text);
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// Sender trust: bank SMS arrive from DLT alpha headers (e.g. "VM-HDFCBK"); a credit
// message from a 10-digit personal number is a likely fake-sender (architecture §7).
// Notification sources carry a package name — not a phone — so they're exempt here.
function isFakeSender(sender: string | null | undefined, source: string): boolean {
  if (!sender) return false;
  if (source === "NOTIFICATION" || source === "ACCESSIBILITY" || source === "EMAIL") return false; // app pkg / email addr, not a phone
  const s = sender.trim();
  if (/^\+?\d{10,13}$/.test(s)) return true;          // personal phone number
  return false;
}

// NOTIFICATION-source credit alerts: we DENYLIST known non-payment apps (email,
// chat, browsers, social, system) so a bank/Paytm *email* in Gmail can never be
// treated as a credit — while still capturing every payment/bank app (Paytm for
// Business, PhonePe Business, bank apps, …) without having to enumerate them all.
// Extend the denylist via TXN_ALERT_BLOCK_APPS (comma-separated package names).
const NOISE_APPS = [
  // Email clients
  "com.google.android.gm", "com.google.android.apps.inbox",
  "com.microsoft.office.outlook", "com.samsung.android.email.provider",
  "com.yahoo.mobile.client.android.mail", "ru.mail.mailapp", "com.fsck.k9",
  // Chat / social
  "com.whatsapp", "com.whatsapp.w4b", "org.telegram.messenger",
  "com.facebook.katana", "com.facebook.orca", "com.instagram.android",
  "com.snapchat.android", "com.twitter.android",
  // Browsers / search / system
  "com.android.chrome", "com.google.android.googlequicksearchbox",
  "com.google.android.gms", "com.android.vending", "android",
  "com.android.systemui", "com.google.android.apps.messaging",
].map((p) => p.toLowerCase());

function noiseAppDenylist(): Set<string> {
  const extra = (process.env.TXN_ALERT_BLOCK_APPS ?? "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return new Set([...NOISE_APPS, ...extra]);
}

// True when a NOTIFICATION alert's source app is a known non-payment app (email,
// chat, browser, …) — noise that must be discarded before it can match an order.
function isNonBankNotification(sender: string | null | undefined, source: string): boolean {
  if (source !== "NOTIFICATION") return false;        // SMS path is handled separately
  const pkg = (sender ?? "").trim().toLowerCase();
  if (!pkg) return true;                               // unidentifiable app → reject
  return noiseAppDenylist().has(pkg);
}

async function audit(actor: string, action: string, entity: string, entityId: string | null, detail: string) {
  await rows("vendorGateway", `
    INSERT INTO vendor_recon_audit (actor, action, entity, entity_id, detail)
    VALUES ($1,$2,$3,$4,$5)
  `, [actor, action, entity, entityId, detail]).catch(() => {});
}

async function raiseSecurityAlert(
  deviceId: string | null, riskType: string, severity: string, detail: string, refAlertId: string | null,
): Promise<string | null> {
  const r = await rows<{ alert_id: string }>("vendorGateway", `
    INSERT INTO vendor_security_alerts (device_id, risk_type, severity, detail, ref_alert_id)
    VALUES ($1,$2,$3,$4,$5) RETURNING alert_id::text
  `, [deviceId, riskType, severity, detail, refAlertId]).catch(() => []);
  return r[0]?.alert_id ?? null;
}

async function openManualCase(
  reason: ManualReason, alertId: string | null, order: Cand | null, deviceId: string | null,
  amount: number, confidence: number, detail: string,
): Promise<string | null> {
  const r = await rows<{ case_id: string }>("vendorGateway", `
    INSERT INTO vendor_manual_cases
      (alert_id, order_id, order_ref, device_id, reason, expected_amount, confidence, detail)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING case_id::text
  `, [alertId, order?.id ?? null, order?.order_id ?? null, deviceId, reason, amount.toFixed(2), confidence, detail])
    .catch(() => []);
  return r[0]?.case_id ?? null;
}

// ── Main ingestion + reconciliation ─────────────────────────────────────────────────

export async function ingestTxnAlert(input: TxnAlertInput): Promise<TxnAlertResult> {
  const source = input.source ?? "DEVICE";
  const deviceId = input.device_id ?? null;
  const amount = Number(input.amount);
  const utr = input.utr?.trim() || null;
  const orderRef = input.order_ref?.trim() || null;
  // Payee (settlement VPA) credited. Paytm/PhonePe "payment received" emails name the
  // account ("In Account of X") but not the VPA, so when the alert is merchant-scoped
  // (e.g. a merchant's own inbox) fall back to that merchant's configured settlement
  // VPA. This attributes the credit to the right branch and lets it reconcile + show
  // on the provider dashboard even when the email text carries no VPA.
  let payee = input.payee_vpa?.trim().toLowerCase() || null;
  if (!payee && input.merchant_id) {
    const sv = await rows<{ v: string | null }>(
      "merchant", `SELECT poolpay->>'settlement_vpa' AS v FROM merchant_payment_config WHERE merchant_code = $1`, [input.merchant_id],
    ).catch(() => []);
    const v = sv[0]?.v?.trim().toLowerCase();
    if (v) payee = v;
  }
  const payerName = input.payer_name?.trim() || null;
  const raw = (input.raw ?? "").slice(0, 2000);
  const actor = `alert:${source}${deviceId ? `:${deviceId}` : ""}`;

  // 1) OTP / auth guard — discard without storing sensitive content.
  if (isAuthMessage(raw) || isAuthMessage(input.narration)) {
    await audit(actor, "ALERT_REJECTED_AUTH", "device", deviceId, "auth/OTP message discarded");
    return { alert_id: null, outcome: "REJECTED", confidence: 0, matched_order_ref: null,
      device_status: "n/a", detail: "auth/OTP message ignored (not stored)" };
  }

  // 1b) Non-bank notification guard — a "credit" notification from an email/chat/
  // browser app (not a real bank/UPI app) is noise (e.g. Gmail showing a bank
  // email). Discard it before it can create a bogus alert or match an order.
  if (isNonBankNotification(input.sender, source)) {
    await audit(actor, "ALERT_REJECTED_NONBANK", "device", deviceId, `non-bank notification source: ${input.sender ?? "unknown"}`);
    return { alert_id: null, outcome: "REJECTED", confidence: 0, matched_order_ref: null,
      device_status: "n/a", detail: `ignored — not a bank/UPI app (${input.sender ?? "unknown"})` };
  }

  const messageHash = sha256(`${deviceId ?? ""}|${raw || `${amount}|${utr ?? ""}`}`);

  // 2) Device trust snapshot (auto-register UNKNOWN on first sight).
  let deviceStatus = "UNKNOWN";
  if (deviceId) {
    const d = await rows<{ status: string }>("vendorGateway",
      `SELECT status FROM vendor_devices WHERE device_id = $1`, [deviceId]).catch(() => []);
    if (d.length) {
      deviceStatus = d[0].status;
      if (input.merchant_id) await rows("vendorGateway",
        `UPDATE vendor_devices SET merchant_id = COALESCE(merchant_id,$2), updated_at = now() WHERE device_id = $1`,
        [deviceId, input.merchant_id]).catch(() => {});
    } else {
      await rows("vendorGateway",
        `INSERT INTO vendor_devices (device_id, status, merchant_id) VALUES ($1,'UNKNOWN',$2) ON CONFLICT DO NOTHING`,
        [deviceId, input.merchant_id ?? null]).catch(() => {});
    }
  }

  // 3) Duplicate / replay detection.
  let duplicate = false;
  let dupDetail = "";
  const dupHash = await rows<{ id: string }>("vendorGateway", `
    SELECT id::text FROM vendor_txn_alerts
     WHERE message_hash = $1 AND created_at >= now() - ($2 || ' hours')::interval LIMIT 1
  `, [messageHash, String(DEDUP_HASH_HOURS)]).catch(() => []);
  if (dupHash.length) { duplicate = true; dupDetail = "identical message hash seen recently"; }
  if (!duplicate && input.nonce) {
    const dupNonce = await rows<{ id: string }>("vendorGateway", `
      SELECT id::text FROM vendor_txn_alerts
       WHERE device_id = $1 AND nonce = $2 AND created_at >= now() - ($3 || ' hours')::interval LIMIT 1
    `, [deviceId, input.nonce, String(NONCE_WINDOW_HOURS)]).catch(() => []);
    if (dupNonce.length) { duplicate = true; dupDetail = "nonce reuse (replay)"; }
  }

  // 5) Order matching — UTR exact, then amount + payee VPA + recency.
  let order: Cand | null = null;
  let confidence = 0;
  let matchDetail = "no pending order matched amount/time";
  let ambiguous = false;

  // Exact order-id match — the strongest signal. Paytm/PhonePe emails echo our UPI
  // note as "Order ID: KP-…", so even when many orders share an amount this resolves
  // to exactly one (order_id is unique per vendor). No ambiguity, no amount tricks.
  if (orderRef) {
    const byRef = await rows<Cand>("vendorGateway", `
      SELECT id::text, order_id, status, lower(COALESCE(meta->>'receiver_vpa','')) AS receiver_vpa, created_at
        FROM vendor_payin_orders WHERE vendor = 'POOLPAY' AND order_id = $1 ORDER BY created_at DESC
    `, [orderRef]).catch(() => []);
    if (byRef.length) { order = byRef[0]; confidence = 100; matchDetail = `exact order id ${orderRef}`; }
  }
  if (utr && !order) {
    const byUtr = await rows<Cand>("vendorGateway", `
      SELECT id::text, order_id, status, lower(COALESCE(meta->>'receiver_vpa','')) AS receiver_vpa, created_at
        FROM vendor_payin_orders WHERE vendor = 'POOLPAY' AND rrn = $1 ORDER BY created_at DESC
    `, [utr]).catch(() => []);
    if (byUtr.length === 1) { order = byUtr[0]; confidence = 100; matchDetail = `exact UTR ${utr}`; }
    else if (byUtr.length > 1) { duplicate = true; dupDetail = `UTR ${utr} on ${byUtr.length} orders`; }
  }
  if (!order && !duplicate) {
    // Candidates include recently-EXPIRED orders (within the recency window) so a
    // genuine LATE payment — one that landed after the order timed out — is not lost.
    // SUCCESS/SUCCEEDED/FAILED are excluded (hard final).
    const cands = await rows<Cand>("vendorGateway", `
      SELECT id::text, order_id, status, lower(COALESCE(meta->>'receiver_vpa','')) AS receiver_vpa, created_at
        FROM vendor_payin_orders
       WHERE vendor = 'POOLPAY' AND status NOT IN ('SUCCESS','SUCCEEDED','FAILED')
         AND amount = $1 AND created_at >= now() - ($2 || ' minutes')::interval
       ORDER BY created_at DESC
    `, [amount.toFixed(2), String(MATCH_WINDOW_MIN)]).catch(() => []);
    // Prefer still-live orders; only fall back to an EXPIRED one when nothing live
    // matches the amount. A confident match on an expired order REVIVES it to SUCCESS
    // (see confirmPoolPayOrder soft-terminal rule) instead of leaving the credit unmatched.
    const live = cands.filter((o) => o.status !== "EXPIRED");
    const base = live.length ? live : cands;
    let pool = base, vpaMatched = false;
    if (payee) { const byVpa = base.filter((o) => o.receiver_vpa === payee); if (byVpa.length) { pool = byVpa; vpaMatched = true; } }
    if (pool.length === 1) {
      order = pool[0];
      const revived = order.status === "EXPIRED" ? " · late payment, reviving expired order" : "";
      // VPA match is the strongest non-UTR signal (95). Real bank credit SMS rarely
      // carry the payee VPA ("Acct XX506 credited with Rs 10.00"), so a UNIQUE
      // amount+recency match that also carries the bank's UTR reference is treated as
      // a confident auto-confirm (90 = threshold). Without any UTR it stays advisory
      // (85) and routes to manual review.
      // A UNIQUE pending order matching the amount within the recency window, from a
      // TRUSTED device, is a confident auto-confirm (90) even without a UTR — payment
      // apps like Paytm for Business notify "₹X received" with no UTR in the text. The
      // VPA / UTR just push confidence higher. Ambiguous (2+ orders) stays manual.
      if (vpaMatched) { confidence = 95; matchDetail = "amount + payee VPA + recency" + revived; }
      else if (utr) { confidence = 95; matchDetail = "amount + recency + bank UTR" + revived; }
      else { confidence = 90; matchDetail = "amount + recency (unique, trusted device)" + revived; }
    }
    else if (pool.length > 1) { ambiguous = true; confidence = 60; matchDetail = `${pool.length} pending orders match amount${vpaMatched ? " + payee VPA" : ""}`; }
  }

  // A parsed "Order ID" that did NOT resolve to one of our orders is the payment
  // provider's OWN transaction reference (e.g. Paytm's "Order ID: HDF…" on a direct
  // UPI credit is the bank RRN, not a KP-… order note). Keep it as the alert's
  // reference so it stays visible for reconciliation on the dashboard instead of
  // being dropped. A real labelled UTR always wins.
  const bankRef = orderRef && orderRef !== (order?.order_id ?? "") ? orderRef : null;
  const storedRef = utr ?? bankRef;

  // 6) Auto-match policy: confidence >= 90 AND device TRUSTED AND not duplicate.
  const fakeSender = isFakeSender(input.sender, source);
  // EMAIL / BANK_API are SERVER-side channels (the merchant's authenticated mailbox /
  // a signed gateway) — higher trust than a phone, so they don't need a TRUSTED device.
  const trusted = deviceStatus === "TRUSTED" || source === "EMAIL" || source === "BANK_API";
  const willConfirm = !!order && !duplicate && !fakeSender && trusted && confidence >= CONFIDENCE_THRESHOLD;

  let outcome: TxnAlertResult["outcome"];
  let detail: string;
  if (duplicate) { outcome = "DUPLICATE"; detail = dupDetail; }
  else if (willConfirm) { outcome = "CONFIRMED"; detail = matchDetail; }
  else if (ambiguous) { outcome = "AMBIGUOUS"; detail = matchDetail; }
  else if (!order) { outcome = "UNMATCHED"; detail = matchDetail; }
  else { outcome = "UNMATCHED"; detail = matchDetail; } // matched but blocked by policy → manual

  // 1c) Enrich-merge: one payment can arrive on two channels — EMAIL (Order ID, no
  // RRN) and ACCESSIBILITY (RRN off the Paytm screen, no Order ID). Rather than store
  // two rows, fold the second into the first so the dashboard shows ONE row carrying
  // both. Only when EXACTLY ONE recent complementary row exists for the same
  // merchant+amount from a different channel — ambiguous same-amount bursts safely fall
  // back to separate rows.
  const rrn = utr && /^\d{12}$/.test(utr) ? utr : null;   // 12-digit UPI RRN
  if (!duplicate && (rrn || orderRef)) {
    let tgtId: string | null = null;
    // Strongest key: the SAME Order ID on a row that still lacks its RRN. Unique per
    // payment, so this merges the retrospective screen-scrape onto the email row even
    // when many payments share an amount (24h window). Email stores the Order ID in
    // both order_ref and utr, so match either.
    if (orderRef) {
      const byOrder = await rows<{ id: string }>("vendorGateway", `
        SELECT id::text FROM vendor_txn_alerts
         WHERE direction = 'CREDIT' AND (order_ref = $1 OR utr = $1)
           AND (utr IS NULL OR utr !~ '^[0-9]{12}$')
           AND created_at >= now() - interval '24 hours'
         ORDER BY created_at DESC LIMIT 2
      `, [orderRef]).catch(() => []);
      if (byOrder.length === 1) tgtId = byOrder[0].id;
    }
    // Fallback: same merchant+amount within a short window, exactly one complementary.
    // VPA guard: when BOTH sides carry a payer VPA, their visible prefix + bank domain must
    // agree — same-amount payments arrive seconds apart in live traffic, and "exactly one
    // complementary row" alone once folded an email onto a DIFFERENT payment's RRN row
    // (live mis-merge 2026-07-06). Rows missing a VPA on either side still merge as before.
    if (!tgtId && input.merchant_id) {
      const compl = await rows<{ id: string }>("vendorGateway", `
        SELECT id::text FROM vendor_txn_alerts
         WHERE merchant_id = $1 AND amount = $2 AND direction = 'CREDIT' AND source <> $3
           AND created_at >= now() - interval '15 minutes'
           AND ( ($4::text IS NOT NULL AND (utr IS NULL OR utr !~ '^[0-9]{12}$'))
              OR ($5::text IS NOT NULL AND order_ref IS NULL) )
           AND ( $6::text IS NULL OR payer_vpa IS NULL
              OR ( lower(split_part(payer_vpa, '@', 2)) = lower(split_part($6::text, '@', 2))
               -- Visible-prefix LENGTHS differ per channel (receipt "96***53@axl" vs email
               -- "9611XX@axl") — one stripped prefix must be a prefix of the other, not equal.
               AND ( regexp_replace(split_part(payer_vpa, '@', 1), '[X*].*$', '')
                       LIKE regexp_replace(split_part($6::text, '@', 1), '[X*].*$', '') || '%'
                  OR regexp_replace(split_part($6::text, '@', 1), '[X*].*$', '')
                       LIKE regexp_replace(split_part(payer_vpa, '@', 1), '[X*].*$', '') || '%' ) ) )
         ORDER BY created_at DESC LIMIT 2
      `, [input.merchant_id, amount.toFixed(2), source, rrn, orderRef, input.payer_vpa ?? null]).catch(() => []);
      if (compl.length === 1) tgtId = compl[0].id;
    }
    // BACKFILL: a one-tapped RRN for an OLDER payment (past the 15-min live window). Match the
    // "no RRN" VPA credit by merchant + amount + the masked payer VPA — its visible leading prefix
    // ("9183…") and bank domain ("@waaxis") line up across channels even though the middle is masked
    // differently ("9183XX@waaxis" vs "9183***771@waaxis"). Payer names don't align, so this is the
    // reliable key. Wide 14-day window; newest matching row wins.
    if (!tgtId && rrn && input.merchant_id && input.payer_vpa) {
      const at = input.payer_vpa.indexOf("@");
      const domain = at >= 0 ? input.payer_vpa.slice(at + 1).toLowerCase() : "";
      const prefix = (at >= 0 ? input.payer_vpa.slice(0, at) : input.payer_vpa).replace(/[X*].*$/, "");
      if (domain && prefix.length >= 2) {
        const bf = await rows<{ id: string }>("vendorGateway", `
          SELECT id::text FROM vendor_txn_alerts
           WHERE merchant_id = $1 AND amount = $2 AND direction = 'CREDIT' AND source <> $3
             AND (utr IS NULL OR utr !~ '^[0-9]{12}$')
             AND created_at >= now() - interval '14 days'
             AND lower(split_part(payer_vpa, '@', 2)) = $4
             -- Prefix-of-prefix, not equality: the receipt and the email mask a different
             -- number of leading chars ("96***53" strips to "96", "9611XX" strips to "9611").
             AND ( regexp_replace(split_part(payer_vpa, '@', 1), '[X*].*$', '') LIKE $5 || '%'
                OR $5 LIKE regexp_replace(split_part(payer_vpa, '@', 1), '[X*].*$', '') || '%' )
           ORDER BY created_at DESC LIMIT 1
        `, [input.merchant_id, amount.toFixed(2), source, domain, prefix]).catch(() => []);
        if (bf.length === 1) tgtId = bf[0].id;
      }
    }
    if (tgtId) {
      await rows("vendorGateway", `
        UPDATE vendor_txn_alerts SET
          utr        = COALESCE($2, utr),
          order_ref  = COALESCE(order_ref, $3),
          payer_name = COALESCE(payer_name, $4),
          payer_vpa  = COALESCE(payer_vpa, $5),
          bank       = COALESCE(bank, $6),
          detail     = COALESCE(detail,'') || ' · +' || $7
        WHERE id = $1::uuid
      `, [tgtId, rrn, orderRef, payerName, input.payer_vpa ?? null, input.bank ?? null, source]).catch(() => {});
      await audit(actor, "ALERT_MERGED", "txn_alert", tgtId,
        `enriched with ${rrn ? "RRN " + rrn : "order " + orderRef} from ${source}`);
      return { alert_id: tgtId, outcome, confidence, matched_order_ref: order?.order_id ?? null,
        device_status: deviceStatus, detail: `merged into existing alert (${rrn ? "RRN" : "Order ID"} added)` };
    }
  }

  // 2) Persist the raw alert + match outcome (append-only).
  const ins = (await rows<{ id: string }>("vendorGateway", `
    INSERT INTO vendor_txn_alerts
      (source, device_id, bank, sender, direction, amount, utr, order_ref, payer_vpa, payer_name, payee_vpa, narration, raw,
       event_time, message_hash, nonce, parser_version, txn_type, device_status,
       matched_order_id, matched_order_ref, match_confidence, outcome, detail, merchant_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, COALESCE($14::timestamptz, now()),
            $15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
    RETURNING id::text
  `, [
    source, deviceId, input.bank ?? null, input.sender ?? null, input.direction ?? "CREDIT",
    amount.toFixed(2), storedRef, orderRef, input.payer_vpa ?? null, payerName, payee, input.narration ?? null, raw,
    input.event_time ?? null, messageHash, input.nonce ?? null, input.parser_version ?? null, "CREDIT", deviceStatus,
    order?.id ?? null, order?.order_id ?? null, confidence, outcome, detail, input.merchant_id ?? null,
  ]))[0];
  const alertId = ins.id;

  // 7) Forensic security alerts.
  let securityAlertId: string | null = null;
  if (duplicate) securityAlertId = await raiseSecurityAlert(deviceId, dupDetail.includes("nonce") ? "NONCE_REUSE" : "DUPLICATE", "HIGH", dupDetail, alertId);
  else if (fakeSender) securityAlertId = await raiseSecurityAlert(deviceId, "FAKE_SENDER", "HIGH", `credit alert from non-bank sender ${input.sender}`, alertId);
  else if (deviceStatus === "SUSPENDED" || deviceStatus === "REVOKED") securityAlertId = await raiseSecurityAlert(deviceId, "SUSPENDED_DEVICE", "HIGH", `alert from ${deviceStatus} device`, alertId);
  else if (deviceStatus === "UNKNOWN" && order && deviceId) securityAlertId = await raiseSecurityAlert(deviceId, "UNKNOWN_DEVICE", "MEDIUM", "alert matched an order from an unregistered device", alertId);

  // 6) Operations fallback — open a manual case for anything not auto-confirmed.
  let manualCaseId: string | null = null;
  if (outcome !== "CONFIRMED") {
    const reason: ManualReason =
      duplicate ? "DUPLICATE"
      : fakeSender ? "SUSPICIOUS_DEVICE"
      : (deviceStatus === "SUSPENDED" || deviceStatus === "REVOKED") ? "SUSPICIOUS_DEVICE"
      : ambiguous ? "AMBIGUOUS"
      : !order ? "UNMATCHED"
      : !trusted ? "UNTRUSTED_DEVICE"
      : "LOW_CONFIDENCE";
    const whyBase = !order && !duplicate ? "no matching pending order"
      : !trusted && order ? `device ${deviceStatus} (must be TRUSTED to auto-confirm)`
      : confidence < CONFIDENCE_THRESHOLD && order ? `confidence ${confidence} < ${CONFIDENCE_THRESHOLD}`
      : detail;
    // Surface the payer (name / VPA) on the case — for UTR-less push credits it's the
    // only signal ops has to match a fixed-amount payment to the right customer.
    const payerTag = payerName ?? input.payer_vpa?.trim() ?? null;
    const why = payerTag ? `from ${payerTag} · ${whyBase}` : whyBase;
    manualCaseId = await openManualCase(reason, alertId, order, deviceId, amount, confidence, why);
  }

  if (manualCaseId || securityAlertId) {
    await rows("vendorGateway", `UPDATE vendor_txn_alerts SET manual_case_id = $2, security_alert_id = $3 WHERE id = $1::uuid`,
      [alertId, manualCaseId, securityAlertId]).catch(() => {});
  }

  // Apply confirmation when policy is satisfied.
  let confirm: ConfirmPoolPayResult | undefined;
  if (outcome === "CONFIRMED" && order) {
    confirm = await confirmPoolPayOrder({
      id: order.id, outcome: "SUCCESS", utr: storedRef, evidence: source === "EMAIL" ? "EMAIL" : "DEVICE", actor,
      settlementStatus: "SETTLED", note: `${source === "EMAIL" ? "email" : "bank"} credit alert${input.bank ? ` (${input.bank})` : ""}`,
    });
    if (!confirm.ok) {
      outcome = confirm.status === 409 ? "DUPLICATE" : "UNMATCHED";
      detail = confirm.error ?? detail;
      const mc = await openManualCase(confirm.status === 409 ? "DUPLICATE" : "UNMATCHED", alertId, order, deviceId, amount, confidence, detail);
      await rows("vendorGateway", `UPDATE vendor_txn_alerts SET outcome = $2, detail = $3, manual_case_id = COALESCE(manual_case_id,$4) WHERE id = $1::uuid`,
        [alertId, outcome, detail, mc]).catch(() => {});
      manualCaseId = manualCaseId ?? mc;
    }
  }

  await audit(actor, `ALERT_${outcome}`, "txn_alert", alertId,
    `${detail}${order ? ` · order ${order.order_id}` : ""} · device ${deviceStatus} · conf ${confidence}`);

  return {
    alert_id: alertId, outcome, confidence, matched_order_ref: order?.order_id ?? null,
    device_status: deviceStatus,
    manual_case_id: manualCaseId ?? undefined, security_alert_id: securityAlertId ?? undefined,
    detail, confirm,
  };
}

export const RECON_POLICY = { CONFIDENCE_THRESHOLD, MATCH_WINDOW_MIN, REPLAY_SKEW_SECONDS };
