// Guided BharatPe setup for one banker (components/merchant/bharatpe-connect.tsx). PURE: validates
// the BharatPe MID config and defines how the Katana agent app signs the credit posts it sends.
//
// BharatPe is a P2P-only pay-in source and has NO API Katana can call or poll. The customer pays the
// banker's BharatPe QR (a UPI ID that lands in the banker's own bank account), so a BharatPe order is
// an ORDINARY pure-P2P order: it carries no meta.gateway, and is confirmed the P2P way — by a credit
// the Katana agent app captures on the merchant's own device and posts back. It is NEVER a gateway
// connector account: a gateway order (meta.gateway.provider set) is excluded from the agent-credit
// reconciler and, with no BharatPe webhook/status API to confirm it, would be stuck PENDING forever.
//
// So "connecting BharatPe" for a banker is two settings:
//   1. the BharatPe UPI ID becomes the banker's P2P settlement VPA (katana_pay), so Katana's pay page
//      shows that QR and a captured credit is attributed to it;
//   2. a per-MID API key + secret (held sealed, agent↔Katana auth): the agent signs each credit post
//      for this MID with the secret, and Katana verifies it before trusting the credit.
//
// The endpoint shown in the card is just Katana's ingestion URL the agent posts to; it is not a
// BharatPe URL. Nothing here logs in to or scrapes BharatPe.

import { createHmac, timingSafeEqual } from "crypto";

export type BharatPeEnv = "TEST" | "PROD";

export interface BharatPeConfigInput {
  /** The BharatPe merchant id, e.g. "711433303641288" (shown on the BharatPe dashboard). */
  bharatpe_merchant_id?: string;
  /** The BharatPe UPI ID the customer pays — becomes the banker's P2P settlement VPA. */
  payee_vpa?: string;
  env?: BharatPeEnv;
}

export interface BharatPeConfig {
  bharatpe_merchant_id: string;
  payee_vpa: string;
  env: BharatPeEnv;
}

/** UPI IDs are case-insensitive; captured credits are stored lowercased, so compare lowercased. */
export function normaliseVpa(v: unknown): string {
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

const VPA_RE = /^[a-z0-9._-]{2,256}@[a-z][a-z0-9.-]{1,64}$/;
const MID_RE = /^[0-9]{6,24}$/;

/** Clean and check what the card sent. A blank field is reported, never silently dropped. */
export function validateBharatPeConfig(input: BharatPeConfigInput): { values?: BharatPeConfig; error?: string } {
  const env: BharatPeEnv = input.env === "PROD" ? "PROD" : "TEST";
  const vpa = normaliseVpa(input.payee_vpa);
  if (!vpa) return { error: "enter the BharatPe UPI ID the customer pays (the QR's UPI ID)" };
  if (!VPA_RE.test(vpa)) return { error: "that BharatPe UPI ID is not a valid UPI ID (name@bank)" };
  const mid = (input.bharatpe_merchant_id ?? "").trim();
  if (mid && !MID_RE.test(mid)) return { error: "the BharatPe merchant ID is digits only (as shown on the BharatPe dashboard)" };
  return { values: { bharatpe_merchant_id: mid, payee_vpa: vpa, env } };
}

// ---- Agent↔Katana auth for a BharatPe MID ---------------------------------------------------------
// The agent app identifies a MID by its API key (bpk_live_… / bpk_test_…, not a secret) and proves
// the post with an HMAC over the timestamp and the exact body, exactly like the device-key scheme.

export const API_KEY_PREFIX: Record<BharatPeEnv, string> = { PROD: "bpk_live_", TEST: "bpk_test_" };

/** The env a key announces, or null if it is not one of ours. */
export function envOfApiKey(apiKey: string): BharatPeEnv | null {
  if (apiKey.startsWith(API_KEY_PREFIX.PROD)) return "PROD";
  if (apiKey.startsWith(API_KEY_PREFIX.TEST)) return "TEST";
  return null;
}

/** The exact string the agent signs: the key binds the signature to this MID, ts stops replay. */
export function bharatpeSigningString(apiKey: string, timestamp: string, body: string): string {
  return `${apiKey}.${timestamp}.${body}`;
}

/** The signature the agent should send (hex HMAC-SHA256 with the MID's sealed secret). */
export function bharatpeSign(apiKey: string, timestamp: string, body: string, secret: string): string {
  return createHmac("sha256", secret).update(bharatpeSigningString(apiKey, timestamp, body)).digest("hex");
}

/** Whether a presented signature is this MID's, in constant time. */
export function verifyBharatPeSignature(apiKey: string, timestamp: string, body: string, secret: string, presented: string): boolean {
  const want = Buffer.from(bharatpeSign(apiKey, timestamp, body, secret));
  const got = Buffer.from(String(presented ?? ""));
  return want.length === got.length && timingSafeEqual(want, got);
}

/** How far a post's timestamp may be from now (same ±5 min as the device agent). */
export const REPLAY_SKEW_MS = 5 * 60 * 1000;

export function timestampFresh(timestamp: string, now = Date.now()): boolean {
  const t = Number(timestamp);
  return Number.isFinite(t) && Math.abs(now - t) <= REPLAY_SKEW_MS;
}
