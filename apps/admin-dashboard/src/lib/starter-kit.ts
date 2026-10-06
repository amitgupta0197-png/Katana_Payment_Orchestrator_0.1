// The Starter Kit: everything a banker's developer needs to integrate and test, written as chat
// messages that Katana staff (or the banker's merchant) paste into WhatsApp or Telegram.
//
// PURE (no `pg`, no server imports). lib/starter-kit-store reads the facts; this turns them into
// messages. The kit follows what the banker was set up for in the admin panel:
//
//   services     pay-in, pay-out or both (lib/merchant-services). A pay-out only banker gets no
//                pay-in messages, a pay-in only banker no payout messages.
//   flow         P2P, Intent or Both (lib/payin-flow): which order endpoint the examples call.
//   webhook      v1 or v2 (lib/webhook-settings): how the developer checks a callback.
//   keys         the TEST Key + Salt in full; a test key cannot move money. The LIVE Key only,
//                with a hint of its Salt: a live Salt is shown once, when it is made, and never
//                put in a message that can be forwarded.
//
// A gateway is never named (lib/merchant-safe): the kit goes to a merchant.
//
// Telegram takes at most 4096 characters per message, so the kit is a few messages, each under
// MAX_PART_CHARS, in the order the developer works through them.

import type { MerchantFlow } from "@/lib/payin-flow";
import { allowsPayin, allowsPayout, type MerchantServicesSetting } from "@/lib/merchant-services";

export const KIT_FORMATS = ["whatsapp", "telegram", "plain"] as const;
export type KitFormat = (typeof KIT_FORMATS)[number];

export const MAX_PART_CHARS = 3900;

/** "short": one message with only what a developer needs to start; "full": the whole guide. */
export const KIT_LENGTHS = ["short", "full"] as const;
export type KitLength = (typeof KIT_LENGTHS)[number];

export interface KitChecklistItem { label: string; done: boolean }

export interface KitFacts {
  bankerName: string;
  merchantCode: string;
  baseUrl: string;
  services: MerchantServicesSetting;
  flow: MerchantFlow;
  /** The test pair, Salt included. Null when there is none. */
  testCreds: { key: string; salt: string; scheme: string } | null;
  /** The live Key and a hint of its Salt. Null when no live pair has been issued. */
  liveKey: { key: string; saltHint: string } | null;
  liveMode: "NOT_REQUESTED" | "REQUESTED" | "ACTIVATED" | "REJECTED";
  liveChecklist: KitChecklistItem[];
  /** `version` is the one in force; `v2Pending` = set to v2 but no signing secret yet, so v1 is sent. */
  webhook: { url: string | null; version: "v1" | "v2"; v2Pending: boolean; paidOnly: boolean; secretHint: string | null };
  /** Where a test payout goes: Katana's own sandbox, or the banker's payout gateway's test system. */
  testPayouts: "SANDBOX" | "GATEWAY";
  /** Limits on live pay-ins, in rupees. Null = none. */
  limits: { min: number | null; max: number | null; daily: number | null };
  /** How live orders are paid: H2H (the UPI link comes in the answer) or REDIRECT; null = not known yet. */
  checkout?: "H2H" | "REDIRECT" | null;
}

export interface KitPart { title: string; text: string }

export interface StarterKit {
  format: KitFormat;
  parts: KitPart[];
  /** For whoever sends the kit: what to fix first. Never part of a message. */
  warnings: string[];
}

// ── Formatting for each messenger ─────────────────────────────────────────────

interface Fmt { b(s: string): string; c(s: string): string; pre(s: string): string }

const FMT: Record<KitFormat, Fmt> = {
  // WhatsApp: *bold*, `inline code`, ```block```.
  whatsapp: { b: (s) => `*${s}*`, c: (s) => `\`${s}\``, pre: (s) => "```\n" + s + "\n```" },
  // Telegram applies its markdown shortcuts when a message is sent: **bold**, `code`, ```block```.
  telegram: { b: (s) => `**${s}**`, c: (s) => `\`${s}\``, pre: (s) => "```\n" + s + "\n```" },
  // SMS, email or anything that shows the characters as typed.
  plain: { b: (s) => s, c: (s) => s, pre: (s) => s.split("\n").map((l) => `    ${l}`).join("\n") },
};

const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;
const lines = (...l: (string | false | null | undefined)[]) => l.filter((x): x is string => typeof x === "string").join("\n");

// ── What applies to this banker ──────────────────────────────────────────────

interface PayinApi { create: string; status: string; note: string | null }

/** The order endpoint the examples call, and its status endpoint. */
export function payinApiFor(f: MerchantFlow): PayinApi {
  if (f.flow === "P2P") return { create: "/api/v1/p2p/order", status: "/api/v1/p2p/order/{id}", note: null };
  if (f.flow === "INTENT") return { create: "/api/v1/intent/order", status: "/api/v1/intent/order/{id}", note: null };
  if (f.flow === "BOTH") return {
    create: "/api/v1/katana-pay/order", status: "/api/pay-status/{id}",
    note: `You are set up for both flows. This endpoint uses your default, ${f.active === "INTENT" ? "Intent" : "P2P"}. To choose per order, call /api/v1/p2p/order or /api/v1/intent/order instead; the request and answer are the same.`,
  };
  return { create: "/api/v1/katana-pay/order", status: "/api/pay-status/{id}", note: null };
}

function flowSentence(f: MerchantFlow): string {
  const p2p = "P2P: your customer pays your UPI ID by app or QR, and the payment is confirmed when the money reaches your account";
  const intent = "Intent: your customer pays through our payment processor, which confirms the payment";
  if (f.flow === "P2P") return p2p + ".";
  if (f.flow === "INTENT") return intent + ".";
  if (f.flow === "BOTH") return `Both. ${p2p}. ${intent}. Default: ${f.active === "INTENT" ? "Intent" : "P2P"}.`;
  return "Chosen by Katana for each order.";
}

function servicesSentence(s: MerchantServicesSetting): string {
  if (s === "PAYIN") return "Collect payments (pay-in)";
  if (s === "PAYOUT") return "Send payouts (pay-out)";
  return "Collect payments and send payouts";
}

const isLegacy = (scheme: string | undefined) => scheme === "PAYU_SHA512" || scheme === "SHA512_LEGACY";

/** The older SHA-512 order signature: key, five order fields, ten empty fields, salt (lib/gateway-creds). */
export const LEGACY_ORDER_STRING = "key|txnid|amount|productinfo|firstname|email" + "|".repeat(11) + "salt";

// ── The messages ────────────────────────────────────────────────────────────

function partWelcome(k: KitFacts, f: Fmt): KitPart {
  const payin = allowsPayin(k.services);
  const t = k.testCreds;
  const live = k.liveMode === "ACTIVATED"
    ? k.liveKey
      ? `Key: ${f.c(k.liveKey.key)}\nSalt: the one you were given when live mode was switched on (ends ${k.liveKey.saltHint.replace(/•/g, "")}). We never send a live Salt in a message.`
      : "Live mode is on. Ask us for your live Key + Salt; we hand the Salt over once, not in a chat."
    : "Your live Key + Salt are made when live mode is switched on (see the last message). Until then, use the test keys.";
  return {
    title: "Welcome and keys",
    text: lines(
      f.b(`1. Katana Starter Kit: ${k.bankerName} (${k.merchantCode})`),
      "",
      "Everything your developer needs to connect to Katana and test it. Work through the messages in order.",
      "",
      f.b("Your account"),
      `• Services: ${servicesSentence(k.services)}`,
      payin && `• How customers pay: ${flowSentence(k.flow)}`,
      payin && k.checkout && `• Live checkout: ${k.checkout === "H2H"
        ? "host-to-host. The order answer carries the UPI link and QR for your own page"
        : "redirect. Send the customer to pay_url; they pay on the hosted payment page"}`,
      `• Base URL: ${k.baseUrl}`,
      `• Webhook URL: ${k.webhook.url ?? "not set yet. Send us the URL where we should post results."}`,
      payin && (k.limits.min != null || k.limits.max != null || k.limits.daily != null) && `• Live pay-in limits: ${[
        k.limits.min != null && `min ${inr(k.limits.min)}`, k.limits.max != null && `max ${inr(k.limits.max)}`,
        k.limits.daily != null && `${inr(k.limits.daily)} a day`,
      ].filter(Boolean).join(", ")}`,
      "",
      f.b("Test keys"),
      "Test keys can't move real money. Use them for everything in this kit.",
      t ? `Key: ${f.c(t.key)}` : "Key: not issued yet. We will send it shortly.",
      t ? `Salt: ${f.c(t.salt)}` : null,
      t ? `Signing: ${isLegacy(t.scheme) ? "SHA-512 (see message 2)" : "HMAC-SHA256"}` : null,
      "",
      f.b("Live keys"),
      live,
      "",
      "Keep the Salt on your server only. Never put it in an app, a web page or a public repository.",
    ),
  };
}

function signLine(k: KitFacts, f: Fmt, fields: string): string {
  if (isLegacy(k.testCreds?.scheme))
    return `hash = SHA-512 hex of ${f.c(LEGACY_ORDER_STRING)} (ten empty fields between email and salt)`;
  return `hash = HMAC-SHA256 hex of ${f.c(fields)}, using ${f.c("Key + Salt")} (joined, no space) as the HMAC key`;
}

function partCreateOrder(k: KitFacts, f: Fmt): KitPart {
  const api = payinApiFor(k.flow);
  const key = k.testCreds?.key ?? "YOUR_TEST_KEY";
  const salt = k.testCreds?.salt ?? "YOUR_TEST_SALT";   // a test Salt: it can't move money
  const legacy = isLegacy(k.testCreds?.scheme);
  const hashCmd = legacy
    ? `HASH=$(printf '%s' "$KEY|$TXNID|$AMOUNT|$INFO||$EMAIL${"|".repeat(11)}$SALT" | openssl dgst -sha512 | sed 's/^.*= //')`
    : `HASH=$(printf '%s' "$TXNID|$AMOUNT|$INFO|$EMAIL" | openssl dgst -sha256 -hmac "$KEY$SALT" | sed 's/^.*= //')`;
  const curl = [
    `KEY="${key}"`,
    `SALT="${salt}"`,
    `TXNID="TEST-0001"; AMOUNT="1.99"`,
    `INFO="Test order"; EMAIL="test@example.com"`,
    hashCmd,
    ``,
    `curl -X POST ${k.baseUrl}${api.create} \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"key":"'"$KEY"'","txnid":"'"$TXNID"'","amount":"'"$AMOUNT"'",`,
    `       "productinfo":"'"$INFO"'","email":"'"$EMAIL"'","hash":"'"$HASH"'"}'`,
  ].join("\n");
  return {
    title: "Create a pay-in order",
    text: lines(
      f.b("2. Create a pay-in order"),
      "",
      `POST ${f.c(k.baseUrl + api.create)}`,
      api.note,
      "",
      f.b("Fields"),
      `• ${f.c("key")}: your Key`,
      `• ${f.c("txnid")}: your own order reference, unique per order (max 60)`,
      `• ${f.c("amount")}: rupees as a string, e.g. "499.00"`,
      `• ${f.c("productinfo")}, ${f.c("email")}: optional, but signed when sent`,
      `• ${f.c("return_url")}: optional, where the customer returns after paying`,
      `• ${f.c("notify_url")}: optional, overrides your webhook URL for this order`,
      `• ${f.c("hash")}: the signature`,
      "",
      f.b("Signature"),
      signLine(k, f, "txnid|amount|productinfo|email"),
      "Leave a field you don't send empty in its place. Send the amount exactly as you signed it.",
      "",
      f.b("Try it (test key)"),
      f.pre(curl),
      "",
      f.b("You get back"),
      `${f.c("201")} with ${f.c("order.id")}, ${f.c("order.status")} = PENDING and ${f.c("pay_url")}. Send your customer to ${f.c("pay_url")}, or show ${f.c("qr_payload")} as a QR on your own page.`,
      `${f.c("checkout")} says which you got: ${f.c("H2H")} (${f.c("upi_intent")} and ${f.c("qr_payload")} are set) or ${f.c("REDIRECT")} (only ${f.c("pay_url")}). Test orders also carry ${f.c("live_checkout")}: what live orders will get.`,
      `Sending the same ${f.c("txnid")} again answers ${f.c("200")} with ${f.c('"reused": true')} and the same order, so a timeout is safe to retry.`,
    ),
  };
}

function partTestPayin(k: KitFacts, f: Fmt): KitPart {
  const api = payinApiFor(k.flow);
  const v2 = k.webhook.version === "v2";
  const verify = v2
    ? lines(
        `We POST JSON with the header ${f.c("X-Katana-Signature: t=<time>,v1=<signature>")}.`,
        `Check: v1 = HMAC-SHA256 hex of ${f.c("<t>.<raw body>")} with your webhook signing secret${k.webhook.secretHint ? ` (ends ${k.webhook.secretHint.replace(/•/g, "")})` : ""}.`,
        `Events: ${f.c("payment.success")}, ${f.c("payment.failed")}, ${f.c("payment.expired")}. ${f.c("amount")} is in paise.`,
        `The same ${f.c("X-Katana-Event-ID")} can arrive more than once: act on it once.`,
      )
    : lines(
        `We POST ${f.c("ORDER_ID")}, ${f.c("STATUS")} (Captured, Failed or Expired), ${f.c("AMOUNT")}, ${f.c("RRN")}, ${f.c("HASH")} and a few more fields. Test orders also carry ${f.c("LIVEMODE=false")}.`,
        `Check HASH: take every field except HASH, sort the names A to Z, join them as ${f.c("NAME=value")} with ${f.c("~")}, add your Salt at the end, SHA-256 it and compare in upper case. Use the Salt of the key that made the order.`,
      );
  return {
    title: "Test pay-ins",
    text: lines(
      f.b("3. Test your pay-ins"),
      "",
      "With a test key, the paise decide what happens:",
      `• ends in ${f.c(".99")}: SUCCESS after about 8 seconds`,
      `• ends in ${f.c(".13")}: FAILED`,
      `• ends in ${f.c(".11")}: EXPIRED`,
      "• anything else: stays PENDING. Open pay_url and tap Simulate success or Simulate failure.",
      "Test orders pay a sandbox UPI ID that no real app can pay, so nothing is charged.",
      "",
      f.b("Check each of these"),
      "1. Create an order for 1.99 and see it turn SUCCESS",
      "2. Your webhook URL receives the result, and your server checks the signature",
      "3. 1.13 turns FAILED and 1.11 turns EXPIRED, and your system handles both",
      "4. Sending the same txnid twice gives back the same order",
      `5. Reading the status yourself: ${f.c(`GET ${k.baseUrl}${api.status}`)} (no signature needed)`,
      "",
      f.b("The webhook"),
      k.webhook.url ? `Goes to ${f.c(k.webhook.url)}. Answer HTTP 200.` : "Send us your webhook URL first. Answer HTTP 200 to every call.",
      verify,
      k.webhook.paidOnly ? "You asked for successful payments only, so failed and expired orders are not posted. Read their status instead." : null,
      "If you don't answer 200 we retry after 1 min, 5 min, 15 min, 1 h, 6 h and 24 h.",
      "",
      f.b("Two things to handle"),
      "• An EXPIRED order can still turn SUCCESS if the payment arrives late. You get a second webhook. Don't cancel the customer's purchase for good on EXPIRED alone.",
      "• SUCCESS is final. It never changes.",
    ),
  };
}

function partPayouts(k: KitFacts, f: Fmt, n: number): KitPart {
  const key = k.testCreds?.key ?? "YOUR_TEST_KEY";
  const salt = k.testCreds?.salt ?? "YOUR_TEST_SALT";
  const legacy = isLegacy(k.testCreds?.scheme);
  const sig = (fields: string) => legacy
    ? `SHA-512 hex of ${f.c(`key|${fields}|salt`)}`
    : `HMAC-SHA256 hex of ${f.c(fields)} with ${f.c("Key + Salt")} as the key`;
  const hash = (fields: string) => legacy
    ? `$(printf '%s' "$KEY|${fields}|$SALT" | openssl dgst -sha512 | sed 's/^.*= //')`
    : `$(printf '%s' "${fields}" | openssl dgst -sha256 -hmac "$KEY$SALT" | sed 's/^.*= //')`;
  const curl = [
    `KEY="${key}"; SALT="${salt}"`,
    ``,
    `# 1. Add the beneficiary`,
    `BHASH=${hash("BEN-001|Ravi Kumar|50100123456789|HDFC0001234|")}`,
    `curl -X POST ${k.baseUrl}/api/v1/payouts/beneficiaries \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"key":"'"$KEY"'","beneficiary_ref":"BEN-001","name":"Ravi Kumar",`,
    `       "account_number":"50100123456789","ifsc":"HDFC0001234","hash":"'"$BHASH"'"}'`,
    ``,
    `# 2. Pay it`,
    `PHASH=${hash("TEST-PO-1|10.99|BEN-001|IMPS|Vendor payment")}`,
    `curl -X POST ${k.baseUrl}/api/v1/payouts/create \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"key":"'"$KEY"'","txnid":"TEST-PO-1","amount":"10.99","beneficiary_ref":"BEN-001",`,
    `       "rail":"IMPS","purpose":"Vendor payment","hash":"'"$PHASH"'"}'`,
  ].join("\n");
  const testing = k.testPayouts === "SANDBOX"
    ? lines(
        "With a test key nothing leaves Katana, and the paise decide what happens:",
        `• ends in ${f.c(".99")}: SUCCESS at once`,
        `• ends in ${f.c(".13")}: FAILED`,
        "• anything else: PROCESSING, then SUCCESS within about a minute",
      )
    : "With a test key, payouts go to our payment processor's test system. No money moves.";
  return {
    title: "Payouts",
    text: lines(
      f.b(`${n}. Send payouts`),
      "",
      f.b("Step 1: add the person you pay"),
      `POST ${f.c(k.baseUrl + "/api/v1/payouts/beneficiaries")}`,
      `Fields: key, beneficiary_ref (your id for them), name, and account_number + ifsc or upi_id, hash.`,
      `hash = ${sig("beneficiary_ref|name|account_number|ifsc|upi_id")}`,
      "With your test key a beneficiary is approved at once, for test payouts only. With your live key Katana approves each new one before it can be paid. Sending the same beneficiary_ref again tells you its status.",
      "",
      f.b("Step 2: send the payout"),
      `POST ${f.c(k.baseUrl + "/api/v1/payouts/create")}`,
      `Fields: key, txnid (your payout reference), amount (rupees, as a string), beneficiary_ref, rail (IMPS, NEFT, RTGS or UPI; optional), purpose, notify_url (optional), hash.`,
      `hash = ${sig("txnid|amount|beneficiary|rail|purpose")}, where beneficiary is the beneficiary_ref you send. Leave a field you don't send empty in its place.`,
      "",
      f.b("Try it (test key)"),
      f.pre(curl),
      "",
      f.b("Step 3: the result"),
      testing,
      `Status: POST ${f.c(k.baseUrl + "/api/v1/payouts/status")} with key, txnid and hash = ${sig("txnid")}.`,
      `Webhook: ${f.c("EVENT=payout.status")} with ${f.c("STATUS")} PROCESSING, ON_HOLD, SUCCESS, FAILED, REJECTED or REVERSED, signed the same way as the pay-in webhook (HASH with your Salt).`,
      "A SUCCESS can later turn REVERSED if the bank returns the money. Send the same txnid again after a timeout: it never pays twice.",
    ),
  };
}

function partErrorsAndLive(k: KitFacts, f: Fmt, n: number): KitPart {
  const payin = allowsPayin(k.services), payout = allowsPayout(k.services);
  const errors: string[] = [
    `• 401 ${f.c("signature mismatch")}: check the field order and that you signed the amount exactly as sent`,
    `• 401 ${f.c("invalid key")}: the Key is wrong, or it was replaced`,
    `• 403 ${f.c("LIVE_MODE_NOT_ACTIVATED")}: a live key was used before live mode is on`,
  ];
  if (payin) errors.push(
    k.flow.flow === "P2P" || k.flow.flow === "INTENT"
      ? `• 409 ${f.c("FLOW_NOT_ENABLED")}: you called the ${k.flow.flow === "P2P" ? "Intent" : "P2P"} endpoint; use ${f.c(payinApiFor(k.flow).create)}`
      : `• 409 ${f.c("FLOW_NOT_SELECTED")}: your account has no flow chosen yet; use ${f.c("/api/v1/katana-pay/order")}`,
    `• 422 ${f.c("AMOUNT_BELOW_MIN")} / ${f.c("AMOUNT_ABOVE_MAX")} / ${f.c("DAILY_LIMIT_EXCEEDED")}: the answer gives the limit and your amount`,
    `• 429 ${f.c("RATE_LIMITED")}: too many orders in one second; wait for Retry-After`,
    `• 403 ${f.c("PAYIN_NOT_ENABLED")}: your account is not set up to collect payments`,
  );
  if (payout) errors.push(
    `• 409 ${f.c("beneficiary not whitelisted")}: Katana hasn't approved the beneficiary yet`,
    `• 409 ${f.c("insufficient … balance")}: not enough balance for this payout`,
    `• 403 ${f.c("PAYOUT_NOT_ENABLED")}: your account is not set up to send payouts`,
  );
  const live = k.liveMode === "ACTIVATED"
    ? "Live mode is on. Swap the test Key + Salt for the live ones and you are live."
    : lines(
        k.liveMode === "REQUESTED" ? "You have asked for live mode. Katana is reviewing it." : "When everything below is ticked, ask us to switch on live mode:",
        ...k.liveChecklist.map((i) => `${i.done ? "✅" : "⬜"} ${i.label}`),
        k.liveMode === "REJECTED" ? "Your last request was turned down. Ask us what to fix." : null,
      );
  return {
    title: "Errors and going live",
    text: lines(
      f.b(`${n}. Errors you may see`),
      "Every refusal has an HTTP status and an error. The ones you are most likely to meet:",
      ...errors,
      "",
      f.b("Going live"),
      live,
      "",
      `Questions? Reply here with your merchant code ${f.c(k.merchantCode)} and the order's txnid.`,
    ),
  };
}

/** The short kit: one message, the essentials only, and a link to the full guide. */
function partShort(k: KitFacts, f: Fmt): KitPart {
  const payin = allowsPayin(k.services), payout = allowsPayout(k.services);
  const api = payinApiFor(k.flow);
  const t = k.testCreds;
  const legacy = isLegacy(t?.scheme);
  const live = k.liveMode === "ACTIVATED"
    ? k.liveKey ? `Live Key: ${f.c(k.liveKey.key)} (live Salt: the one you were given; never sent in chat)` : "Live: on. Ask us for your live Key + Salt."
    : "Live keys: after go-live. Test with the keys above until then.";
  return {
    title: "Starter kit",
    text: lines(
      f.b(`Katana: ${k.bankerName} (${k.merchantCode})`),
      "",
      t ? `Test Key: ${f.c(t.key)}` : "Test Key: on its way.",
      t ? `Test Salt: ${f.c(t.salt)}` : null,
      live,
      "",
      payin && `Create order: POST ${f.c(k.baseUrl + api.create)}`,
      payin && `Hash: ${legacy ? `SHA-512 of ${f.c(LEGACY_ORDER_STRING)}` : `HMAC-SHA256 of ${f.c("txnid|amount|productinfo|email")}, key = Key+Salt`}`,
      payin && k.checkout && `Checkout: ${k.checkout === "H2H" ? "host-to-host (UPI link in the answer)" : "redirect (send the customer to pay_url)"}`,
      payout && `Payouts: POST ${f.c(k.baseUrl + "/api/v1/payouts/create")}`,
      `Callback URL: ${k.webhook.url ?? "not set yet, please send us yours"}`,
      "",
      `Full guide: ${k.baseUrl}/katana-pay-integration.html`,
      `Questions: reply here with the txnid.`,
    ),
  };
}

/** Split a message that is too long at a blank line, keeping every piece under the limit. */
function fit(part: KitPart): KitPart[] {
  if (part.text.length <= MAX_PART_CHARS) return [part];
  const out: KitPart[] = [];
  let cur = "";
  for (const block of part.text.split("\n\n")) {
    const next = cur ? `${cur}\n\n${block}` : block;
    if (next.length > MAX_PART_CHARS && cur) { out.push({ title: part.title, text: cur }); cur = block; }
    else cur = next;
  }
  if (cur) out.push({ title: part.title, text: cur });
  return out.map((p, i) => (out.length > 1 ? { ...p, title: `${p.title} (${i + 1}/${out.length})` } : p));
}

/** What whoever sends the kit should fix first. Staff and merchant words, never a gateway's name. */
export function kitWarnings(k: KitFacts): string[] {
  const w: string[] = [];
  if (!k.testCreds) w.push("No test Key + Salt yet, so the kit can't show them. Generate a test pair under Developer.");
  if (!k.webhook.url) w.push("No webhook URL is saved, so the developer can't receive results yet.");
  if (allowsPayin(k.services) && k.flow.flow === "UNSET") w.push("No pay-in flow is selected. The kit uses the general order endpoint until one is chosen.");
  if (k.services === "UNSET") w.push("No services are selected for this banker's merchant, so the kit covers both pay-in and pay-out.");
  if (k.webhook.v2Pending) w.push("Webhook v2 has no signing secret yet, so results are sent in the v1 format, which the kit describes.");
  return w;
}

export function buildStarterKit(k: KitFacts, format: KitFormat = "whatsapp", length: KitLength = "full"): StarterKit {
  const f = FMT[format];
  if (length === "short") return { format, parts: [partShort(k, f)], warnings: kitWarnings(k) };
  const payin = allowsPayin(k.services), payout = allowsPayout(k.services);
  const parts: KitPart[] = [partWelcome(k, f)];
  if (payin) parts.push(partCreateOrder(k, f), partTestPayin(k, f));
  if (payout) parts.push(partPayouts(k, f, parts.length + 1));
  parts.push(partErrorsAndLive(k, f, parts.length + 1));
  return { format, parts: parts.flatMap(fit), warnings: kitWarnings(k) };
}

