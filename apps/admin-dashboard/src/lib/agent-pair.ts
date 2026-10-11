// Pairing a Katana Agent phone with a banker by QR or code (vendorGateway 0047). Pure.
// Storage in lib/agent-pair-store; staff make a code at POST /api/merchants/{id}/agent-pair, the
// phone redeems it at POST /api/v1/agent/pair.

import type { P2pApp } from "@/lib/p2p-method";

/** No 0/O, 1/I/L: read aloud or typed from a screen without mistakes. */
export const PAIR_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const PAIR_CODE_LENGTH = 8;
export const PAIR_TTL_MINUTES = 15;

/** A fresh code from random bytes (crypto in the store; pure here for tests). */
export function pairCodeFrom(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < PAIR_CODE_LENGTH; i++) s += PAIR_ALPHABET[bytes[i] % PAIR_ALPHABET.length];
  return s;
}

/** What a person typed → the code, or null. Spaces, dashes and case are forgiven. */
export function normalisePairCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, "");
  if (s.length !== PAIR_CODE_LENGTH) return null;
  for (const c of s) if (!PAIR_ALPHABET.includes(c)) return null;
  return s;
}

/** "ABCD-EFGH": how the code is shown. */
export const showPairCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

export function pairLink(base: string, code: string): string {
  return `${base.replace(/\/$/, "")}/pair/${code}`;
}

/** The agent's PAYMENT APPS switch for a QR app (Prefs.APP_*). OTHER: no app engine (bank SMS). */
export function agentAppFor(app: P2pApp | null): string | null {
  switch (app) {
    case "BHARATPE": return "BHARATPE";
    case "GPAY": return "GPAY";
    case "PHONEPE": return "PHONEPE";
    case "PAYTM": return "PAYTM";
    default: return null;
  }
}

/** What the phone is told when it pairs. The BharatPe secret is in it once, for that phone. */
export interface PairPayload {
  merchant_code: string;
  merchant_name: string;
  base_url: string;
  /** Prefs.APP_* to switch on alone, or null to leave the switches as they are. */
  capture_app: string | null;
  bharatpe: { api_key: string; secret: string; env: "TEST" | "PROD" } | null;
}

/**
 * "bpk_live_dm_F…xy" — the same hint the agent sends (BharatpeUploader.keyHint), so the server can
 * tell whether a phone holds a given MID's key without ever receiving the key.
 */
export function bharatpeKeyHint(apiKey: string): string {
  return apiKey.length > 14 ? apiKey.slice(0, 13) + "…" + apiKey.slice(-2) : apiKey;
}
