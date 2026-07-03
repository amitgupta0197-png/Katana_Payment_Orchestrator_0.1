// Server-side EMAIL ingestion — a fallback capture channel for business-merchant
// credits (Paytm / PhonePe for Business) whose push notification didn't reach the
// Android agent. Polls a dedicated Gmail/IMAP inbox for "Payment Received" emails,
// parses amount + payer, and feeds them into the SAME reconciler as the agent
// (source = EMAIL, a server-trusted channel). The email carries no UTR and no order
// id, so it matches on amount + recency exactly like the push — but it always
// arrives, so it removes the dependency on the flaky notification.
//
// Config (.env.local on the VPS):
//   EMAIL_INGEST_ENABLED=1
//   EMAIL_INGEST_HOST=imap.gmail.com          (default)
//   EMAIL_INGEST_PORT=993                      (default)
//   EMAIL_INGEST_USER=receiver@gmail.com
//   EMAIL_INGEST_PASSWORD=<gmail app password> (NOT the normal password)
//   EMAIL_INGEST_MERCHANT=UK-108               (merchant code to attribute the credit)
//
// Idempotency: only UNSEEN mail is fetched and each message is marked \Seen after it
// is examined, so a payment email is processed exactly once.

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { ingestTxnAlert, isAuthMessage } from "@/lib/txn-reconcile";
import { rows } from "@/lib/pg";
import { getAccessToken, startGmailWatch } from "@/lib/gmail-oauth";

export interface EmailIngestResult {
  enabled: boolean;
  scanned: number;
  ingested: number;
  results: Array<{ amount: number; payer: string | null; outcome: string; confidence: number; matched: string | null }>;
  error?: string;
}

// One mailbox to poll (from the DB inbox registry or the legacy env config).
export interface InboxConfig {
  email: string;
  appPassword?: string;     // IMAP auth
  authType?: string;        // IMAP | OAUTH
  refreshToken?: string;    // OAUTH auth (Gmail API)
  host?: string;
  port?: number;
  merchantId?: string;
  fromDb?: boolean;
}

function imapClient(cfg: InboxConfig): ImapFlow {
  return new ImapFlow({
    host: cfg.host || "imap.gmail.com",
    port: cfg.port || 993,
    secure: true,
    auth: { user: cfg.email, pass: cfg.appPassword },
    logger: false,
  });
}

// Best-effort login check used by the app's "Connect Gmail" action for instant
// feedback ("connected" vs the IMAP error, e.g. bad app password / IMAP disabled).
export async function testInboxConnection(cfg: InboxConfig): Promise<{ ok: boolean; error?: string }> {
  const client = imapClient(cfg);
  try { await client.connect(); await client.logout(); return { ok: true }; }
  catch (e) { try { await client.logout(); } catch { /* ignore */ } return { ok: false, error: (e as Error).message }; }
}

// Load every mailbox to poll: enabled rows in the inbox registry, plus the legacy
// single env-configured inbox if present.
async function loadInboxes(): Promise<InboxConfig[]> {
  const list: InboxConfig[] = [];
  if (process.env.EMAIL_INGEST_ENABLED === "1" && process.env.EMAIL_INGEST_USER && process.env.EMAIL_INGEST_PASSWORD) {
    list.push({
      email: process.env.EMAIL_INGEST_USER,
      appPassword: process.env.EMAIL_INGEST_PASSWORD,
      host: process.env.EMAIL_INGEST_HOST,
      port: process.env.EMAIL_INGEST_PORT ? Number(process.env.EMAIL_INGEST_PORT) : undefined,
      merchantId: process.env.EMAIL_INGEST_MERCHANT,
    });
  }
  const db = await rows<any>("vendorGateway",
    `SELECT email, app_password, auth_type, refresh_token, host, port, merchant_id FROM vendor_email_inboxes WHERE enabled = true`).catch(() => []);
  const seen = new Set(list.map((c) => c.email.toLowerCase()));
  for (const r of db) {
    if (seen.has(String(r.email).toLowerCase())) continue;
    list.push({ email: r.email, appPassword: r.app_password ?? undefined, authType: r.auth_type, refreshToken: r.refresh_token ?? undefined,
      host: r.host, port: r.port, merchantId: r.merchant_id ?? undefined, fromDb: true });
  }
  return list;
}

// Poll every configured inbox (called by the cron). Updates each DB inbox's status.
export async function pollAllInboxes(): Promise<{ enabled: boolean; inboxes: number; scanned: number; ingested: number; perInbox: Array<{ email: string } & EmailIngestResult> }> {
  const inboxes = await loadInboxes();
  let scanned = 0, ingested = 0;
  const perInbox: Array<{ email: string } & EmailIngestResult> = [];
  for (const cfg of inboxes) {
    const r = await pollOneInbox(cfg);
    scanned += r.scanned; ingested += r.ingested;
    perInbox.push({ email: cfg.email, ...r });
    if (cfg.fromDb) {
      await rows("vendorGateway",
        `UPDATE vendor_email_inboxes SET last_polled_at = now(), status = $2, last_error = $3 WHERE email = $1`,
        [cfg.email, r.error ? "ERROR" : "OK", r.error ?? null]).catch(() => {});
    }
  }
  return { enabled: inboxes.length > 0, inboxes: inboxes.length, scanned, ingested, perInbox };
}

// Poll a single inbox by email address — used by the Gmail push webhook to fetch the
// new mail the instant Google notifies us (near-instant capture).
export async function pollInboxByEmail(email: string): Promise<EmailIngestResult | null> {
  const db = await rows<any>("vendorGateway",
    `SELECT email, app_password, auth_type, refresh_token, host, port, merchant_id
       FROM vendor_email_inboxes WHERE lower(email) = lower($1) AND enabled = true LIMIT 1`, [email]).catch(() => []);
  if (!db.length) return null;
  const r = db[0];
  const cfg: InboxConfig = {
    email: r.email, appPassword: r.app_password ?? undefined, authType: r.auth_type, refreshToken: r.refresh_token ?? undefined,
    host: r.host, port: r.port, merchantId: r.merchant_id ?? undefined, fromDb: true,
  };
  const res = await pollOneInbox(cfg);
  await rows("vendorGateway", `UPDATE vendor_email_inboxes SET last_polled_at = now(), status = $2, last_error = $3 WHERE email = $1`,
    [cfg.email, res.error ? "ERROR" : "OK", res.error ?? null]).catch(() => {});
  return res;
}

// Start/renew the Gmail push watch for every connected OAuth inbox. Called on connect
// and by a periodic cron (Gmail watches expire within 7 days).
export async function startWatchAll(): Promise<{ enabled: boolean; watches: Array<{ email: string; ok: boolean; expiration?: string; error?: string }> }> {
  if (!process.env.GOOGLE_PUBSUB_TOPIC) return { enabled: false, watches: [] };
  const db = await rows<any>("vendorGateway",
    `SELECT email, refresh_token FROM vendor_email_inboxes WHERE auth_type = 'OAUTH' AND enabled = true AND refresh_token IS NOT NULL`).catch(() => []);
  const watches: Array<{ email: string; ok: boolean; expiration?: string; error?: string }> = [];
  for (const r of db) {
    try {
      const w = await startGmailWatch(r.refresh_token);
      if (w?.expiration) {
        await rows("vendorGateway", `UPDATE vendor_email_inboxes SET watch_expiration = to_timestamp(($2::bigint)/1000) WHERE email = $1`,
          [r.email, w.expiration]).catch(() => {});
      }
      watches.push({ email: r.email, ok: true, expiration: w?.expiration });
    } catch (e) { watches.push({ email: r.email, ok: false, error: (e as Error).message }); }
  }
  return { enabled: true, watches };
}

// Only act on real payment-provider senders/subjects (never random inbox mail).
const PAYMENT_SENDER_RE = /paytm|phonepe|razorpay|bharatpe|gpay|google\s*pay|npci/i;
// Paytm-for-Business phrases a received payment as "Rs. X paid at …" (from the payer's
// action), so "paid" counts as a credit here — safe because we only parse payment-
// provider senders. Also covers "received/credited/added".
const CREDIT_RE = /\b(received|credited|payment\s+received|you(?:'ve| have)?\s+received|added\s+to|\bpaid\b)\b/i;
const AMOUNT_RE = /(?:₹|rs\.?|inr)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/gi;
const BALANCE_RE = /(?:avl\.?\s*bal|available\s*balance|balance)[:\s]*(?:₹|rs\.?|inr)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i;
const PAYER_NAME_RE = /\bfrom\s+((?:mr|mrs|ms|dr|m\/s)\.?\s+)?([a-z][a-z .&'-]{1,59}?)(?=\s*(?:$|[,.\n·—|(]|\bvia\b|\bon\b|\bupi\b|\bref\b|@))/i;
const VPA_RE = /([a-z0-9._-]{2,}@[a-z]{2,})/i;
// Our order id, echoed by Paytm/PhonePe as "Order ID: KP-…" (it's the UPI note we
// attach). Exact match → no same-amount ambiguity.
const ORDER_REF_RE = /order\s*(?:id|no|ref(?:erence)?)?[:\s#]+([A-Za-z][A-Za-z0-9-]{4,40})/i;
// Bank reference (UTR / UPI Ref No / RRN). UPI RRNs are 12 digits; NEFT/IMPS can be
// longer. We REQUIRE a recognised label before the digits so a phone number, amount,
// or order number is never mistaken for the UTR. Captured group 1 = the reference.
const UTR_RE = /\b(?:UPI\s*Ref(?:erence)?(?:\s*(?:No\.?|ID|Number))?|UTR|RRN|Bank\s*Ref(?:erence)?(?:\s*(?:No\.?|ID))?|Ref(?:erence)?\s*No\.?)\s*[:.#=-]?\s*([0-9]{11,22})\b/i;

function toAmount(s: string | undefined | null): number | null {
  if (!s) return null;
  const v = Number(s.replace(/,/g, ""));
  return Number.isFinite(v) && v > 0 ? v : null;
}

interface ParsedEmail { amount: number; payerName: string | null; payerVpa: string | null; orderRef: string | null; utr: string | null }

// Extract the credited amount + payer from a payment-received email. Returns null if
// it isn't a credit (or is an OTP/auth mail, which is never acted on).
export function parsePaymentEmail(subject: string, body: string): ParsedEmail | null {
  const text = `${subject}\n${body}`.replace(/[ \t]+/g, " ").trim();
  if (!text) return null;
  // OTP/verification emails carry it in the SUBJECT ("Your OTP is …"). We must NOT
  // check the body, because payment emails include a "never share your OTP/PIN/
  // password" security footer that would otherwise reject every real credit.
  if (isAuthMessage(subject)) return null;
  if (!CREDIT_RE.test(text)) return null;          // must read like a credit

  const balance = toAmount(BALANCE_RE.exec(text)?.[1]);
  let amount: number | null = null;
  for (const m of text.matchAll(AMOUNT_RE)) {
    const v = toAmount(m[1]);
    if (v && v !== balance) { amount = v; break; }  // first non-balance amount
  }
  if (!amount) return null;

  let payerName: string | null = null;
  const nm = PAYER_NAME_RE.exec(text);
  if (nm) {
    const title = (nm[1] ?? "").trim();
    const core = (nm[2] ?? "").trim();
    if (core && !core.includes("@")) {
      const name = `${title} ${core}`.replace(/\s+/g, " ").trim();
      if (name.length >= 3 && !/\d/.test(name)) payerName = name.slice(0, 120);
    }
  }
  const payerVpa = VPA_RE.exec(text)?.[1] ?? null;
  const orderRef = ORDER_REF_RE.exec(text)?.[1]?.trim() ?? null;
  const utr = UTR_RE.exec(text)?.[1] ?? null;
  return { amount, payerName, payerVpa, orderRef, utr };
}

// Decode a Gmail API message payload into plain text (walks MIME parts).
function gmailBody(payload: any): string {
  if (!payload) return "";
  const decode = (d?: string) => (d ? Buffer.from(d, "base64url").toString("utf8") : "");
  const cleanHtml = (s: string) => s
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&#8377;|&#x20b9;|&rupee;/gi, "₹");
  const walk = (part: any): string => {
    if (!part) return "";
    if (part.mimeType === "text/plain" && part.body?.data) return decode(part.body.data);
    if (part.parts) {
      for (const p of part.parts) { const t = walk(p); if (t) return t; }
    }
    if (part.mimeType === "text/html" && part.body?.data) return cleanHtml(decode(part.body.data));
    return "";
  };
  return walk(payload) || cleanHtml(decode(payload.body?.data));
}

// Poll a Gmail inbox via the Gmail API (OAuth). readonly scope → idempotency tracked
// in vendor_email_seen so each message is ingested once.
async function pollOneInboxOAuth(cfg: InboxConfig): Promise<EmailIngestResult> {
  const out: EmailIngestResult = { enabled: true, scanned: 0, ingested: 0, results: [] };
  if (!cfg.refreshToken) { out.enabled = false; return out; }
  try {
    const access = await getAccessToken(cfg.refreshToken);
    const auth = { authorization: `Bearer ${access}` };
    const q = encodeURIComponent('newer_than:2d (from:paytm OR from:phonepe OR subject:received OR subject:"payment received")');
    const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=25`, { headers: auth });
    if (!listRes.ok) throw new Error(`gmail list HTTP ${listRes.status}`);
    const list: any = await listRes.json();
    for (const { id } of list.messages || []) {
      const dup = await rows("vendorGateway", `SELECT 1 FROM vendor_email_seen WHERE email=$1 AND message_id=$2`, [cfg.email, id]).catch(() => []);
      if ((dup as any[]).length) continue;
      out.scanned++;
      await rows("vendorGateway", `INSERT INTO vendor_email_seen (email, message_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [cfg.email, id]).catch(() => {});
      const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, { headers: auth });
      if (!msgRes.ok) continue;
      const msg: any = await msgRes.json();
      const headers: any[] = msg.payload?.headers || [];
      const h = (n: string) => headers.find((x) => x.name?.toLowerCase() === n)?.value || "";
      const subject = h("subject"), from = h("from").toLowerCase();
      if (!PAYMENT_SENDER_RE.test(`${from} ${subject}`)) continue;
      const hit = parsePaymentEmail(subject, gmailBody(msg.payload));
      if (!hit) continue;
      const eventTime = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : new Date().toISOString();
      const r = await ingestTxnAlert({
        source: "EMAIL", merchant_id: cfg.merchantId || undefined,
        bank: /phonepe/i.test(from) ? "PHONEPE" : /paytm/i.test(from) ? "PAYTM" : undefined,
        amount: hit.amount, order_ref: hit.orderRef ?? undefined, payer_name: hit.payerName ?? undefined, payer_vpa: hit.payerVpa ?? undefined, utr: hit.utr ?? undefined,
        sender: from || "email", raw: `${subject} — ${gmailBody(msg.payload)}`.slice(0, 2000),
        event_time: eventTime, parser_version: "email-oauth-1.0",
      });
      out.ingested++;
      out.results.push({ amount: hit.amount, payer: hit.payerName, outcome: r.outcome, confidence: r.confidence, matched: r.matched_order_ref });
    }
  } catch (e) { out.error = (e as Error).message; }
  return out;
}

// Debug: show what the OAuth inbox actually contains and what the parser extracts,
// ignoring the seen-set and the payment filter — used to diagnose missed captures.
export async function debugEmail(): Promise<any> {
  const inboxes = (await loadInboxes()).filter((c) => c.authType === "OAUTH" && c.refreshToken);
  if (!inboxes.length) return { error: "no OAuth inbox connected" };
  const cfg = inboxes[0];
  try {
    const access = await getAccessToken(cfg.refreshToken!);
    const auth = { authorization: `Bearer ${access}` };
    const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent("newer_than:1d")}&maxResults=15`, { headers: auth });
    const list: any = await listRes.json();
    const out: any[] = [];
    for (const { id } of (list.messages || []).slice(0, 15)) {
      const m: any = await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, { headers: auth })).json();
      const headers: any[] = m.payload?.headers || [];
      const h = (n: string) => headers.find((x) => x.name?.toLowerCase() === n)?.value || "";
      const subject = h("subject"), from = h("from").toLowerCase();
      const body = gmailBody(m.payload);
      const full = `${subject}\n${body}`.replace(/\s+/g, " ");
      const orderIdHit = /\bKP-[A-Za-z0-9]{4,}-[A-Za-z0-9]{3,}\b/i.exec(full)?.[0] ?? null;
      out.push({ from, subject, senderMatch: PAYMENT_SENDER_RE.test(`${from} ${subject}`), parsed: parsePaymentEmail(subject, body), orderIdHit, snippet: full.slice(0, 700) });
    }
    return { email: cfg.email, count: out.length, messages: out };
  } catch (e) { return { error: (e as Error).message }; }
}

// Poll a single mailbox. OAuth → Gmail API; otherwise IMAP (app password).
export async function pollOneInbox(cfg: InboxConfig): Promise<EmailIngestResult> {
  if (cfg.authType === "OAUTH" || cfg.refreshToken) return pollOneInboxOAuth(cfg);
  if (!cfg.email || !cfg.appPassword) return { enabled: false, scanned: 0, ingested: 0, results: [] };
  const merchantId = cfg.merchantId || undefined;
  const client = imapClient(cfg);

  const out: EmailIngestResult = { enabled: true, scanned: 0, ingested: 0, results: [] };
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const since = new Date(Date.now() - 24 * 3600 * 1000);
      const uids = await client.search({ seen: false, since }, { uid: true });
      const list = (uids || []).slice(-50); // bound work per run
      for (const uid of list) {
        out.scanned++;
        const msg = await client.fetchOne(String(uid), { source: true, envelope: true }, { uid: true });
        if (!msg || !msg.source) continue;
        const from = (msg.envelope?.from?.[0]?.address || "").toLowerCase();
        const fromName = msg.envelope?.from?.[0]?.name || "";
        const subject = msg.envelope?.subject || "";

        // Mark examined (so it's never re-scanned) regardless of outcome.
        const markSeen = () => client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true }).catch(() => {});

        if (!PAYMENT_SENDER_RE.test(`${from} ${fromName} ${subject}`)) { await markSeen(); continue; }

        const parsed = await simpleParser(msg.source);
        const body = parsed.text || (parsed.html ? String(parsed.html).replace(/<[^>]+>/g, " ") : "");
        const hit = parsePaymentEmail(subject, body);
        await markSeen();
        if (!hit) continue;

        const eventTime = (msg.envelope?.date instanceof Date ? msg.envelope.date : new Date()).toISOString();
        const r = await ingestTxnAlert({
          source: "EMAIL",
          merchant_id: merchantId,
          bank: /phonepe/i.test(from) ? "PHONEPE" : /paytm/i.test(from) ? "PAYTM" : undefined,
          amount: hit.amount,
          order_ref: hit.orderRef ?? undefined,
          payer_name: hit.payerName ?? undefined,
          payer_vpa: hit.payerVpa ?? undefined,
          utr: hit.utr ?? undefined,
          sender: from || "email",
          raw: `${subject} — ${body}`.slice(0, 2000),
          event_time: eventTime,
          parser_version: "email-1.0",
        });
        out.ingested++;
        out.results.push({ amount: hit.amount, payer: hit.payerName, outcome: r.outcome, confidence: r.confidence, matched: r.matched_order_ref });
      }
    } finally {
      lock.release();
    }
  } catch (e) {
    out.error = (e as Error).message;
  } finally {
    try { await client.logout(); } catch { /* ignore */ }
  }
  return out;
}
