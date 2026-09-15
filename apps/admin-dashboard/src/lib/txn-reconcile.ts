// Transaction Intelligence — bank-credit alert ingestion, forensic checks, and
// reconciliation (per "SMS Transaction Reconciliation & Forensic Security
// Architecture", §3 Level-1 DFD and §6 Reconciliation Logic).
//
// Pipeline for one CREDIT alert:
//   1) OTP / auth-message guard  — never store or act on OTP/PIN/password messages.
//   1e) Settlement guard         — the app moving its own held money to the merchant's bank
//                                  is not new money; recorded, never counted (see
//                                  lib/settlement-credit.ts).
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
import { processPayin } from "@/lib/dt-payin";
import { isSettlementCredit, SETTLEMENT_TXN_TYPE } from "@/lib/settlement-credit";

// Policy knobs (architecture §6 / §8).
const CONFIDENCE_THRESHOLD = 90;      // auto-confirm bar
const MATCH_WINDOW_MIN = 30;          // order recency window for matching
const DEDUP_HASH_HOURS = 24;          // same message hash within this = duplicate
const NONCE_WINDOW_HOURS = 24;        // nonce reuse within this = replay
const DEDUP_ECHO_SECONDS = 20;        // same device+amount, no RRN, within this = one payment pushed twice
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
  /** Full payment detail as stated by the capturing screen; shape varies per source. */
  details?: Record<string, string>;
  event_time?: string;
  nonce?: string;
  parser_version?: string;
  sim_id?: string;
  app_hash?: string;
}

export interface TxnAlertResult {
  alert_id: string | null;
  // REJECTED and SETTLEMENT are classifications, not match outcomes, and are not stored in
  // vendor_txn_alerts.outcome (whose CHECK constraint allows only the four matching states).
  // A rejected alert is never stored at all; a settlement is stored with outcome UNMATCHED —
  // literally true, no order matched it — and txn_type = 'SETTLEMENT', which is what excludes
  // it from every collection feed.
  outcome: "CONFIRMED" | "UNMATCHED" | "AMBIGUOUS" | "DUPLICATE" | "REJECTED" | "SETTLEMENT";
  confidence: number;
  matched_order_ref: string | null;
  device_status: string;
  manual_case_id?: string;
  security_alert_id?: string;
  detail: string;
  confirm?: ConfirmPoolPayResult;
}

interface Cand { id: string; order_id: string; status: string; receiver_vpa: string; created_at: string; amount: number }

// Credited amount must equal the order amount before a match can auto-confirm. Tolerance
// is sub-paisa to absorb float/numeric round-trips; anything larger is a genuine mismatch.
function amountMatches(orderAmount: number, alertAmount: number): boolean {
  return Math.abs(Number(orderAmount) - Number(alertAmount)) < 0.01;
}

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
  "com.microsoft.office.outlook", "com.samsung.android.email.merchant",
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

// Close any open on-demand RRN capture request against a credit once its RRN lands.
// Best-effort: the table may not exist on an un-migrated env, so failures are swallowed.
async function closeCaptureRequest(alertId: string) {
  await rows("vendorGateway", `
    UPDATE vendor_capture_requests SET status = 'DONE', fulfilled_at = now()
     WHERE alert_id = $1::uuid AND status IN ('PENDING','SENT')
  `, [alertId]).catch(() => {});
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

// #1 auto-fill: a payment-email credit (Paytm/PhonePe "₹X received") lands carrying the
// provider's internal ref but NO 12-digit UPI RRN — the real RRN only lives on the Paytm
// Business detail screen. If the merchant has a LIVE capture device (agent heartbeated
// recently), auto-raise an on-demand capture request so the agent re-sweeps Paytm and
// backfills the RRN — no manual "Get RRN" click per row. Deduped by the partial-unique
// index on alert_id; skipped when no device is live (the request would only expire).
// Returns the request id when one is raised, else null.
async function maybeAutoCaptureRequest(
  merchantId: string, alertId: string, amount: number, payerVpa: string | null,
): Promise<string | null> {
  const live = await rows<{ device_id: string }>("vendorGateway", `
    SELECT device_id FROM vendor_devices
     WHERE merchant_id = $1 AND COALESCE(agent_enabled, true)
       AND last_heartbeat > now() - interval '20 minutes' LIMIT 1
  `, [merchantId]).catch(() => []);
  if (!live.length) return null;
  const r = await rows<{ id: string }>("vendorGateway", `
    INSERT INTO vendor_capture_requests (alert_id, merchant_id, amount, payer_vpa, requested_by)
    SELECT $1::uuid, $2, $3, $4, 'auto:no-rrn'
     WHERE NOT EXISTS (SELECT 1 FROM vendor_capture_requests
                        WHERE alert_id = $1::uuid AND status IN ('PENDING','SENT'))
    RETURNING id::text
  `, [alertId, merchantId, amount.toFixed(2), payerVpa]).catch(() => []);
  return r[0]?.id ?? null;
}

// ── Main ingestion + reconciliation ─────────────────────────────────────────────────

// `channelTrusted` is asserted ONLY by internal server-side callers (the email poller)
// that reached this function through their own authenticated channel — never from a public
// HTTP body. It is what lets a merchant's own mailbox (source EMAIL) or a signed gateway
// (BANK_API) auto-confirm without a registered device. The public /api/v1/txn-alert route
// must NOT set it, so a request cannot self-declare a trusted channel via `source` (audit C3).
export async function ingestTxnAlert(
  input: TxnAlertInput,
  opts: { channelTrusted?: boolean } = {},
): Promise<TxnAlertResult> {
  const channelTrusted = opts.channelTrusted === true;
  const source = input.source ?? "DEVICE";
  const deviceId = input.device_id ?? null;
  const amount = Number(input.amount);
  const utr = input.utr?.trim() || null;
  const orderRef = input.order_ref?.trim() || null;
  // ORDER MATCHING IS SCOPED TO THE BANKER THE CREDIT BELONGS TO. Order refs are unique per
  // banker, not platform-wide (vendorGateway 0024/0025), and many bankers take the same
  // amounts, so an unscoped lookup could confirm ANOTHER banker's order with a real credit.
  // When the capture carries no banker code the lookup stays unscoped (the credit has no
  // other owner), and a ref shared by several bankers goes to manual review instead.
  const scopeMerchant = input.merchant_id?.trim() || null;
  // Payee (settlement VPA) credited — STORED ONLY WHEN THE CAPTURE ACTUALLY STATED IT.
  //
  // This used to fall back to the banker's configured PRIMARY settlement VPA whenever the
  // alert carried none, on the theory that it named the right account anyway. It does not: a
  // banker can receive on several UPI IDs (PRVZS23 has four), and GPay for Business never
  // reports which one the customer paid — not in the push, not on the detail screen. So the
  // fallback stamped the primary VPA onto every credit and the dashboard displayed it as
  // fact, showing one VPA for payments that had actually arrived on different ones (client
  // report 2026-08-17: 74 of 76 stored credits carried the primary, and not one carried any
  // of the three additional IDs).
  //
  // Nothing depended on the guess. Attribution is by the banker code the agent stamps
  // (`merchant_id`), which is the only trustworthy key since bankers SHARE settlement VPAs;
  // the payee_vpa scoping fallback applies only to rows with NO banker code, and the guess
  // required one, so it never fed that path. It did defeat the one check that wanted a real
  // stated value — verificationOf()'s VPA-mismatch test compared the config against itself
  // and could never fire.
  //
  // Now: null means "the payment did not say". A destination can still be established — see
  // the device mapping below — but only from something an operator asserted, and it is stored
  // with a source marker so the UI never presents a derivation as the payment's own words.
  const statedPayee = input.payee_vpa?.trim().toLowerCase() || null;
  let payee = statedPayee;
  let payeeSource: "STATED" | "DEVICE" | null = statedPayee ? "STATED" : null;
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

  // 1e) SETTLEMENT GUARD — old money moving one leg further, not a new collection.
  //
  // "₹40,006.00 deposited — ₹40,006.00 for transactions settled to your bank account" is GPay
  // for Business paying yesterday's captured collections into the merchant's bank account. The
  // parser sees "deposited" and forwards it; every dedup layer below is blind to it because a
  // settlement shares no identity with the payments it settles (no RRN, its own wording, its
  // own nonce, hours later, no stated payment time). Left alone it lands as a fresh
  // "awaiting RRN" credit and states the same takings twice — which is exactly what the
  // 2026-08-17 report showed: ₹125,046 of settlement legs counted as collections.
  //
  // So it is diverted here, ahead of duplicate detection and order matching. The row is still
  // stored — a settlement is the proof that collected money reached the bank, and dropping it
  // would leave the phone's upload unaccounted for — but it never matches an order, never
  // opens a manual case, never consumes a DT lot, and never appears in a collection total.
  if (isSettlementCredit({ raw, narration: input.narration, payer_name: payerName, payer_vpa: input.payer_vpa, utr })) {
    // The app re-posts its settlement notice as readily as it re-posts a payment, so keep one
    // row per notice: identical text from the same device inside a day is the same leg.
    const already = await rows<{ id: string }>("vendorGateway", `
      SELECT id::text FROM vendor_txn_alerts
       WHERE message_hash = $1 AND COALESCE(txn_type,'') = $2
         AND created_at >= now() - ($3 || ' hours')::interval
       LIMIT 1
    `, [messageHash, SETTLEMENT_TXN_TYPE, String(DEDUP_HASH_HOURS)]).catch(() => []);
    if (already.length) {
      await audit(actor, "ALERT_SETTLEMENT_DUP", "txn_alert", already[0].id, `settlement notice re-posted (₹${amount.toFixed(2)})`);
      return { alert_id: already[0].id, outcome: "SETTLEMENT", confidence: 0, matched_order_ref: null,
        device_status: deviceStatus, detail: "settlement to bank account — already recorded" };
    }
    const detail = "settled to bank account by the payment app — not a customer payment, excluded from collections";
    const ins = await rows<{ id: string }>("vendorGateway", `
      INSERT INTO vendor_txn_alerts
        (source, device_id, bank, sender, direction, amount, utr, payee_vpa, narration, raw,
         event_time, message_hash, nonce, parser_version, txn_type, device_status,
         match_confidence, outcome, detail, merchant_id, details)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, COALESCE($11::timestamptz, now()),
              $12,$13,$14,$15,$16,0,'UNMATCHED',$17,$18,$19::jsonb)
      RETURNING id::text
    `, [
      source, deviceId, input.bank ?? null, input.sender ?? null, input.direction ?? "CREDIT",
      amount.toFixed(2), utr, statedPayee, input.narration ?? null, raw,
      input.event_time ?? null, messageHash, input.nonce ?? null, input.parser_version ?? null,
      SETTLEMENT_TXN_TYPE, deviceStatus, detail, input.merchant_id ?? null,
      input.details && Object.keys(input.details).length ? JSON.stringify(input.details) : null,
    ]).catch(() => []);
    await audit(actor, "ALERT_SETTLEMENT", "txn_alert", ins[0]?.id ?? null,
      `₹${amount.toFixed(2)} settled to bank account · ${statedPayee ?? "account not named"}`);
    return { alert_id: ins[0]?.id ?? null, outcome: "SETTLEMENT", confidence: 0, matched_order_ref: null,
      device_status: deviceStatus, detail };
  }

  // 2b) DESTINATION FROM THE CAPTURING DEVICE.
  //
  // The payment does not say which of the banker's UPI IDs it landed on, but the phone does:
  // one phone holds one GPay for Business login, and the agent only ever sees its own phone's
  // notifications. So when an operator has recorded what that device receives on (validated
  // against the banker's own configured VPAs), every credit it captures inherits it — marked
  // DEVICE, never passed off as the payment's own statement.
  //
  // Deliberately AFTER the settlement branch: a settlement leg is a deposit into the bank
  // account, not a credit to a UPI ID, so it must not acquire one.
  // THE MAPPING IS PER PHONE *AND* PER BANKER. A phone's banker code is typed into the agent
  // and can be changed: "Author new" captured for PRIMESX and later for PRVZS23. The mapping was
  // validated against one banker's configured VPAs, so it may only be applied to that banker's
  // traffic — otherwise re-typing the code would silently stamp one banker's UPI ID onto
  // another's credits. An alert carrying no banker code still takes it: the device is then the
  // only thing that knows where the money went.
  if (!payee && deviceId) {
    const dv = await rows<{ v: string | null; m: string | null }>("vendorGateway",
      `SELECT receiving_vpa AS v, merchant_id AS m FROM vendor_devices WHERE device_id = $1`,
      [deviceId]).catch(() => []);
    const v = dv[0]?.v?.trim().toLowerCase();
    const owner = dv[0]?.m?.trim() || null;
    const sameBanker = !input.merchant_id || !owner || owner === input.merchant_id;
    if (v && sameBanker) { payee = v; payeeSource = "DEVICE"; }
  }

  // 3) Duplicate / replay detection.
  let duplicate = false;
  let dupDetail = "";
  let benignRecapture = false;
  // Same 12-digit UPI RRN seen recently = the SAME payment re-captured, never new money
  // (RRNs are unique per UPI transaction). The agent's seen-set is in-memory, so a
  // restart re-uploads the whole visible reports list — and Airtel's relative "paid at"
  // text drifts between scrapes, so the message-hash check alone misses those replays.
  // Checked FIRST so an RRN-bearing re-upload is classed as a benign re-scrape (no HIGH
  // security alert, no manual case) instead of an identical-hash replay.
  if (utr && /^\d{12}$/.test(utr)) {
    // Target the BEST stored copy (confirmed > real-amount > earliest) — the one the
    // feed shows — so a repair lands on the visible row, not another junk duplicate.
    const dupRrn = await rows<{ id: string; amount: number }>("vendorGateway", `
      SELECT id::text, amount::float AS amount FROM vendor_txn_alerts
       WHERE direction = 'CREDIT' AND utr = $1
         AND created_at >= now() - ($2 || ' hours')::interval
       ORDER BY (outcome = 'CONFIRMED') DESC, (amount > 0) DESC, created_at ASC LIMIT 1
    `, [utr, String(DEDUP_HASH_HOURS)]).catch(() => []);
    if (dupRrn.length) {
      duplicate = true; benignRecapture = true; dupDetail = `RRN ${utr} already captured (re-scrape)`;
      // Self-heal: a mid-load first scrape can store ₹0 with a junk payer (the RRN node
      // renders before the amount does). When the re-scrape carries the real amount,
      // repair the stored row in place instead of keeping the junk forever.
      if (amount > 0 && Number(dupRrn[0].amount) === 0) {
        await rows("vendorGateway", `
          UPDATE vendor_txn_alerts
             SET amount = $2, payer_name = COALESCE($3, payer_name), payer_vpa = COALESCE($4, payer_vpa),
                 detail = COALESCE(detail,'') || ' · amount repaired by re-scrape'
           WHERE id = $1::uuid
        `, [dupRrn[0].id, amount.toFixed(2), payerName, input.payer_vpa ?? null]).catch(() => {});
        dupDetail += ` · repaired ₹0 original to ${amount.toFixed(2)}`;
      }
    }
  }
  if (!duplicate) {
    const dupHash = await rows<{ id: string }>("vendorGateway", `
      SELECT id::text FROM vendor_txn_alerts
       WHERE message_hash = $1 AND created_at >= now() - ($2 || ' hours')::interval LIMIT 1
    `, [messageHash, String(DEDUP_HASH_HOURS)]).catch(() => []);
    if (dupHash.length) { duplicate = true; dupDetail = "identical message hash seen recently"; }
  }
  if (!duplicate && input.nonce) {
    const dupNonce = await rows<{ id: string }>("vendorGateway", `
      SELECT id::text FROM vendor_txn_alerts
       WHERE device_id = $1 AND nonce = $2 AND created_at >= now() - ($3 || ' hours')::interval LIMIT 1
    `, [deviceId, input.nonce, String(NONCE_WINDOW_HOURS)]).catch(() => []);
    if (dupNonce.length) { duplicate = true; dupDetail = "nonce reuse (replay)"; }
  }
  // ECHO: one payment delivered as TWO pushes. GPay posts an initial notification and then
  // an updated one seconds later; the wording differs, so the hash differs, and each upload
  // carries its own nonce — neither check above can see them as the same payment, and with
  // no RRN on either side there is no identity to match on. Live example 2026-08-15: two
  // ₹1 credits from one device in the SAME second, different hashes, different nonces.
  //
  // Falls back to "same device, same banker code, same amount, within seconds". The window
  // is deliberately TIGHT: wrongly collapsing two genuine same-amount payments would
  // UNDER-report real money, which is far worse than briefly showing a duplicate. A few
  // seconds is long enough for the echo and short enough that a real pair is very unlikely.
  if (!duplicate && !(utr && /^\d{12}$/.test(utr)) && amount > 0) {
    const echo = await rows<{ id: string }>("vendorGateway", `
      SELECT id::text FROM vendor_txn_alerts
       WHERE direction = 'CREDIT'
         AND device_id IS NOT DISTINCT FROM $1
         AND merchant_id IS NOT DISTINCT FROM $2
         AND amount = $3
         AND (utr IS NULL OR utr !~ '^[0-9]{12}$')
         AND created_at >= now() - ($4 || ' seconds')::interval
       ORDER BY created_at DESC LIMIT 1
    `, [deviceId, input.merchant_id ?? null, amount.toFixed(2), String(DEDUP_ECHO_SECONDS)])
      .catch(() => []);
    if (echo.length) {
      duplicate = true;
      benignRecapture = true;   // a double-posted push is not a security event
      dupDetail = `echo of the same credit within ${DEDUP_ECHO_SECONDS}s (no RRN to match on)`;
    }
  }
  // SAME PAYMENT, RE-NOTIFIED LATER. GPay posts a credit again minutes afterwards under a
  // different title — "Payments you receive will be shown here — ₹11 received from Kush D
  // at 10:01 pm" vs "₹11 received from Kush D at 10:01 pm". Different wording means a
  // different hash, a fresh upload means a different nonce, and the ten-minute gap is far
  // outside the echo window, so nothing above sees them as one payment. They also cannot
  // enrich-merge, because that only folds across DIFFERENT sources and both are pushes.
  //
  // Both texts do state the payment's OWN time, and two notifications for one payment always
  // agree on it. So the identity is amount + that in-text time — exact rather than windowed,
  // which is what makes it safe: two genuine same-amount payments occur at different times
  // and are never collapsed.
  // IDENTITY AT VOLUME. amount + in-text time is a good identifier for a shop doing a few
  // payments an hour, and a BAD one as volume rises: two customers paying the same amount in
  // the same minute stop being rare, and merging them under-reports real money. So it is used
  // only while we have nothing better. A 12-digit RRN is unique per UPI transaction and is
  // handled by the RRN check far above; this fallback deliberately does not run once the
  // incoming alert carries one.
  const textTime = (input.raw ?? "").match(/\b(\d{1,2}:\d{2}\s?[ap]\.?m\.?)\b/i)?.[1];
  const ownRrn = utr && /^\d{12}$/.test(utr) ? utr : null;
  if (!duplicate && textTime && amount > 0) {
    const twin = await rows<{ id: string; utr: string | null; details: unknown }>("vendorGateway", `
      SELECT id::text, utr, details FROM vendor_txn_alerts
       WHERE direction = 'CREDIT'
         AND merchant_id IS NOT DISTINCT FROM $1
         AND amount = $2
         AND raw ILIKE '%' || $3 || '%'
         -- RRN wins over the heuristic: a candidate carrying a DIFFERENT 12-digit reference
         -- is provably a different payment, however well amount and time line up. This is
         -- what keeps amount+time safe as volume rises -- as soon as either side has a real
         -- reference, that reference decides.
         AND ($4::text IS NULL OR utr IS NULL OR utr !~ '^[0-9]{12}$' OR utr = $4::text)
         AND created_at >= now() - interval '24 hours'
       ORDER BY created_at ASC LIMIT 1
    `, [input.merchant_id ?? null, amount.toFixed(2), textTime, ownRrn]).catch(() => []);
    if (twin.length) {
      duplicate = true;
      benignRecapture = true;
      dupDetail = `same payment re-notified (₹${amount.toFixed(2)} at "${textTime}")`;
      // The row we keep must end up with everything we learned, not just whichever half
      // arrived first. A later delivery is frequently the ONLY one carrying the reference,
      // the payer's name or the full detail block, and marking it duplicate without folding
      // those across would hide the richest record behind the poorest one.
      const twinHasRrn = twin[0].utr && /^\d{12}$/.test(twin[0].utr);
      const foldRrn = utr && /^\d{12}$/.test(utr) && !twinHasRrn;
      const foldDetails = input.details && Object.keys(input.details).length > 0 && !twin[0].details;
      if (foldRrn || foldDetails || payerName || statedPayee) {
        await rows("vendorGateway", `
          UPDATE vendor_txn_alerts
             SET utr        = COALESCE($2, utr),
                 details    = COALESCE(details, $3::jsonb),
                 payer_name = COALESCE(payer_name, $4),
                 -- Destination account, if this delivery is the one that knew it.
                 payee_vpa        = COALESCE(payee_vpa, $5),
                 payee_vpa_source = CASE WHEN payee_vpa IS NULL AND $5::text IS NOT NULL
                                         THEN 'STATED' ELSE payee_vpa_source END,
                 detail     = COALESCE(detail,'') || ' · enriched from re-notification'
           WHERE id = $1::uuid
        `, [
          twin[0].id,
          foldRrn ? utr : null,
          foldDetails ? JSON.stringify(input.details) : null,
          payerName ?? null,
          statedPayee,
        ]).catch(() => {});
        if (foldRrn) dupDetail += ` · RRN ${utr} folded onto the original`;
        if (foldDetails) dupDetail += " · detail folded onto the original";
      }
    }
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
      SELECT id::text, order_id, status, lower(COALESCE(meta->>'receiver_vpa','')) AS receiver_vpa, created_at, amount::float AS amount
        FROM vendor_payin_orders WHERE vendor = 'POOLPAY' AND order_id = $1
         AND ($2::text IS NULL OR merchant_id = $2)
       ORDER BY created_at DESC
    `, [orderRef, scopeMerchant]).catch(() => []);
    if (byRef.length > 1) {
      ambiguous = true; confidence = 60;
      matchDetail = `order id ${orderRef} exists for ${byRef.length} merchants — alert carries no merchant code`;
    } else if (byRef.length === 1) {
      order = byRef[0];
      if (amountMatches(order.amount, amount)) { confidence = 100; matchDetail = `exact order id ${orderRef}`; }
      // Order id matched but the credited amount differs — NEVER auto-confirm a mismatch
      // (a ₹1 alert must not clear a ₹50k order, nor defeat HIGH_AMOUNT_HOLD). Route to
      // manual review by keeping confidence below the auto-confirm bar (audit H1).
      else { confidence = 40; matchDetail = `order id ${orderRef} matched but amount mismatch (alert ₹${amount.toFixed(2)} vs order ₹${Number(order.amount).toFixed(2)})`; }
    }
  }
  if (utr && !order) {
    const byUtr = await rows<Cand>("vendorGateway", `
      SELECT id::text, order_id, status, lower(COALESCE(meta->>'receiver_vpa','')) AS receiver_vpa, created_at, amount::float AS amount
        FROM vendor_payin_orders WHERE vendor = 'POOLPAY' AND rrn = $1
         AND ($2::text IS NULL OR merchant_id = $2)
       ORDER BY created_at DESC
    `, [utr, scopeMerchant]).catch(() => []);
    if (byUtr.length === 1) {
      order = byUtr[0];
      if (amountMatches(order.amount, amount)) { confidence = 100; matchDetail = `exact UTR ${utr}`; }
      else { confidence = 40; matchDetail = `UTR ${utr} matched but amount mismatch (alert ₹${amount.toFixed(2)} vs order ₹${Number(order.amount).toFixed(2)})`; }
    }
    else if (byUtr.length > 1) { duplicate = true; dupDetail = `UTR ${utr} on ${byUtr.length} orders`; }
  }
  if (!order && !duplicate && !ambiguous) {
    // Candidates include recently-EXPIRED orders (within the recency window) so a
    // genuine LATE payment — one that landed after the order timed out — is not lost.
    // SUCCESS/SUCCEEDED/FAILED are excluded (hard final).
    const cands = await rows<Cand>("vendorGateway", `
      SELECT id::text, order_id, status, lower(COALESCE(meta->>'receiver_vpa','')) AS receiver_vpa, created_at, amount::float AS amount
        FROM vendor_payin_orders
       WHERE vendor = 'POOLPAY' AND status NOT IN ('SUCCESS','SUCCEEDED','FAILED')
         AND amount = $1 AND created_at >= now() - ($2 || ' minutes')::interval
         AND ($3::text IS NULL OR merchant_id = $3)
       ORDER BY created_at DESC
    `, [amount.toFixed(2), String(MATCH_WINDOW_MIN), scopeMerchant]).catch(() => []);
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
  // But that elevated trust is granted ONLY when the caller proved it came through such a
  // channel (channelTrusted, set by the internal poller) — never because the request BODY
  // said so. A public request that merely sets source:"EMAIL"/"BANK_API" gets no trust and
  // must still present a TRUSTED device (audit C3).
  const trusted =
    deviceStatus === "TRUSTED" ||
    (channelTrusted && (source === "EMAIL" || source === "BANK_API"));
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
           -- A row already judged DUPLICATE is the same payment seen twice, not a second
           -- candidate. Counting it made "exactly one complementary row" fail and blocked
           -- the merge entirely: a ₹6 push arriving twice left the RRN stranded on its own
           -- row while the credit still showed "no RRN" (live 2026-08-15).
           AND COALESCE(outcome,'') <> 'DUPLICATE'
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
          -- The DESTINATION account travels too. A notification never names which of the
          -- merchant's UPI IDs was credited; the on-device screen read does, and that read
          -- arrives as this second sighting. Without folding it across, the row the dashboard
          -- shows would stay blank while the answer sat on a row marked duplicate.
          payee_vpa        = COALESCE(payee_vpa, $8),
          payee_vpa_source = CASE WHEN payee_vpa IS NULL AND $8::text IS NOT NULL
                                  THEN 'STATED' ELSE payee_vpa_source END,
          detail     = COALESCE(detail,'') || ' · +' || $7
        WHERE id = $1::uuid
      `, [tgtId, rrn, orderRef, payerName, input.payer_vpa ?? null, input.bank ?? null, source,
          statedPayee]).catch(() => {});
      // An on-demand capture request against this credit is now fulfilled — close it so
      // the dashboard button clears and the agent stops re-issuing it.
      if (rrn) await closeCaptureRequest(tgtId);
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
       matched_order_id, matched_order_ref, match_confidence, outcome, detail, merchant_id, details,
       payee_vpa_source, livemode)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, COALESCE($14::timestamptz, now()),
            $15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26::jsonb,$27,$28)
    RETURNING id::text
  `, [
    source, deviceId, input.bank ?? null, input.sender ?? null, input.direction ?? "CREDIT",
    amount.toFixed(2), storedRef, orderRef, input.payer_vpa ?? null, payerName, payee, input.narration ?? null, raw,
    input.event_time ?? null, messageHash, input.nonce ?? null, input.parser_version ?? null, "CREDIT", deviceStatus,
    order?.id ?? null, order?.order_id ?? null, confidence, outcome, detail, input.merchant_id ?? null,
    input.details && Object.keys(input.details).length ? JSON.stringify(input.details) : null,
    payeeSource,
    // A SIMULATED credit is test traffic: it is recorded as such and stays out of collections.
    source !== "SIMULATED",
  ]))[0];
  const alertId = ins.id;

  // 7) Forensic security alerts.
  let securityAlertId: string | null = null;
  // A benign re-scrape (agent restart re-reading the same reports list) is expected
  // churn, not an attack — log it LOW so a restart doesn't flood HIGH alerts.
  if (duplicate) securityAlertId = await raiseSecurityAlert(deviceId, dupDetail.includes("nonce") ? "NONCE_REUSE" : "DUPLICATE", benignRecapture ? "LOW" : "HIGH", dupDetail, alertId);
  else if (fakeSender) securityAlertId = await raiseSecurityAlert(deviceId, "FAKE_SENDER", "HIGH", `credit alert from non-bank sender ${input.sender}`, alertId);
  else if (deviceStatus === "SUSPENDED" || deviceStatus === "REVOKED") securityAlertId = await raiseSecurityAlert(deviceId, "SUSPENDED_DEVICE", "HIGH", `alert from ${deviceStatus} device`, alertId);
  else if (deviceStatus === "UNKNOWN" && order && deviceId) securityAlertId = await raiseSecurityAlert(deviceId, "UNKNOWN_DEVICE", "MEDIUM", "alert matched an order from an unregistered device", alertId);

  // 6) Operations fallback — open a manual case for anything not auto-confirmed.
  // Benign re-scrapes are skipped: the ORIGINAL alert already carries whatever case
  // matters, so a duplicate row needs no ops action of its own.
  let manualCaseId: string | null = null;
  if (outcome !== "CONFIRMED" && !benignRecapture) {
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

  // AUTO-FILL THE RRN FOR ANY CREDIT THAT ARRIVED WITHOUT ONE.
  //
  // This was EMAIL-only, on the reasoning that a device capture already carries its on-device
  // RRN. It does when the phone kept up. Under real volume it does not: a burst of payments
  // arrives as pushes faster than the phone can open each one, so the credit is recorded from
  // the notification (which never states the reference) and the RRN is simply missing — and
  // because nothing raised a capture request for a NOTIFICATION credit, nobody went back for
  // it. That is the manual "Get RRN" clicking the merchant ended up doing by hand for every
  // payment the agent could not reach in time (live run 2026-08-18, ~60-70% captured).
  //
  // The request is what drives the phone to go and look, so raise it for whatever channel the
  // credit came in on. It is deduped by the partial-unique index on alert_id, expires by
  // itself after 30 minutes, and is skipped entirely when the merchant has no live device —
  // so a quiet merchant is unaffected and a busy one gets an automatic retry per payment
  // instead of an operator clicking a button per row.
  //
  // ACCESSIBILITY is excluded: that channel exists only because the RRN was read off the
  // screen, so one arriving without a 12-digit reference is a failed read, not a payment
  // awaiting one — asking the same screen again would just loop.
  if (!rrn && !duplicate && source !== "ACCESSIBILITY" && input.merchant_id) {
    const reqId = await maybeAutoCaptureRequest(input.merchant_id, alertId, amount, input.payer_vpa ?? null);
    if (reqId) await audit(actor, "CAPTURE_AUTO_REQUESTED", "txn_alert", alertId, `no RRN on ${source.toLowerCase()} credit → auto capture request to live device`);
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

  // DT population attribution. A CONFIRMED credit is the merchant repaying, in pay-in
  // traffic, the USDT advance Katana gave it — so it consumes that merchant's oldest ACTIVE
  // purchase lot. Runs only after `outcome` has settled (the confirm block above can demote
  // it to DUPLICATE/UNMATCHED), is gated on DT_MODULE_ENABLED, and is fully isolated:
  // reconciliation is the system of record and must never fail because DT accounting did.
  if (outcome === "CONFIRMED") {
    try {
      const dt = await processPayin({ alert_id: alertId, banker_code: input.merchant_id ?? null, amount });
      if (dt.status === "CONSUMED")
        await audit(actor, "DT_PAYIN_CONSUMED", "txn_alert", alertId, `lot ${dt.purchase_id} · banker ${dt.banker_id} · ${dt.amount}`);
      else if (dt.status === "UNALLOCATED")
        await audit(actor, "DT_PAYIN_UNALLOCATED", "txn_alert", alertId, `${dt.reason} · ${dt.amount}`);
    } catch { /* advisory only — never block ingestion */ }
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
