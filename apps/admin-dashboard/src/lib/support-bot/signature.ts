// Why a merchant's order signature was refused (the support bot's check_signature tool).
// PURE apart from `crypto`.
//
// The request log keeps only a hint of each hash: its first four characters and its length
// (lib/api-log redactBody). That is enough to tell which of the usual mistakes the merchant made:
// Katana works out the hash each likely mistake would have produced and compares its start with
// the hint. Nothing secret is returned, only which way of signing matched and the string that
// should have been signed (without the Salt).

import { createHash, createHmac } from "crypto";

export interface SigCreds { key: string; salt: string; scheme: string }
export interface OrderFields { txnid: string; amount: string; productinfo?: string; firstname?: string; email?: string }

/** The redacted hash in the log: "ab12…(64)". Null when there is no usable hint. */
export function parseHashHint(hint: unknown): { prefix: string; length: number } | null {
  const m = typeof hint === "string" ? /^(.{4})…\((\d+)\)$/.exec(hint) : null;
  return m ? { prefix: m[1], length: Number(m[2]) } : null;
}

const hmac = (key: string, s: string) => createHmac("sha256", key).update(s).digest("hex");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const sha512 = (s: string) => createHash("sha512").update(s).digest("hex");

export const isLegacyScheme = (s: string) => s === "PAYU_SHA512" || s === "SHA512_LEGACY";

/** The string a correct signature is made over (the Salt is not in it for the HMAC scheme). */
export function canonicalString(f: OrderFields, scheme: string): string {
  if (isLegacyScheme(scheme))
    return ["<key>", f.txnid, f.amount, f.productinfo ?? "", f.firstname ?? "", f.email ?? "", ...Array(10).fill(""), "<salt>"].join("|");
  return [f.txnid, f.amount, f.productinfo ?? "", f.email ?? ""].join("|");
}

function correct(c: SigCreds, f: OrderFields): string {
  if (isLegacyScheme(c.scheme))
    return sha512([c.key, f.txnid, f.amount, f.productinfo ?? "", f.firstname ?? "", f.email ?? "", ...Array(10).fill(""), c.salt].join("|"));
  return hmac(c.key + c.salt, [f.txnid, f.amount, f.productinfo ?? "", f.email ?? ""].join("|"));
}

export type SigVerdict =
  | "CORRECT"            // the hint matches the right hash: the refusal had another cause, or a different request
  | "AMOUNT_FORMAT"      // signed the amount written differently (499 vs 499.00)
  | "MISSING_FIELDS"     // signed without productinfo/email that were sent
  | "SALT_KEY_ORDER"     // HMAC key was Salt + Key instead of Key + Salt
  | "OTHER_MODE_SALT"    // used the test Salt with the live key, or the reverse
  | "PLAIN_SHA256"       // SHA-256 of the string instead of HMAC
  | "SHA256_WITH_SALT"   // SHA-256 of the string with the Salt appended
  | "UPPERCASE"          // right hash, sent in upper case
  | "WRONG_SCHEME"       // used the other signing scheme
  | "UNKNOWN";           // none of the usual mistakes: they signed something else

export interface SigDiagnosis {
  verdict: SigVerdict;
  /** What should have been signed (no Salt in it). */
  should_sign: string;
  scheme: string;
  sent_length: number;
  expected_length: number;
  explanation: string;
}

const EXPLAIN: Record<SigVerdict, string> = {
  CORRECT: "The hash they sent starts the same as the correct one, so the signature looks right for this request. If it was still refused, check the full hash was sent, untruncated, in the same request.",
  AMOUNT_FORMAT: "They signed the amount written differently from the amount they sent (for example 499 in the hash but 499.00 in the body). Sign exactly the amount string you send.",
  MISSING_FIELDS: "They left productinfo and/or email out of the signed string but sent them in the request. Every field you send must be in the signed string, in order; a field you do not send is signed as empty.",
  SALT_KEY_ORDER: "They used Salt + Key as the HMAC key. It must be Key followed by Salt, with nothing between them.",
  OTHER_MODE_SALT: "They signed with the Salt of the other mode: the test Salt with the live key, or the live Salt with the test key. Each key has its own Salt.",
  PLAIN_SHA256: "They used plain SHA-256. It must be HMAC-SHA256 with Key + Salt as the HMAC key.",
  SHA256_WITH_SALT: "They used SHA-256 of the string with the Salt added at the end. It must be HMAC-SHA256 with Key + Salt as the HMAC key.",
  UPPERCASE: "The hash is right but was sent in upper case. Send it in lower-case hex.",
  WRONG_SCHEME: "They signed with the other signing scheme (SHA-512 instead of HMAC-SHA256, or the reverse). Use the scheme of their key.",
  UNKNOWN: "The hash matches none of the usual mistakes, so they signed a different string or used a different key. Print the exact string being signed and compare it with the one below, character by character.",
};

/** Which way of signing produced the hash whose hint was logged. */
export function diagnoseOrderSignature(
  f: OrderFields, hint: { prefix: string; length: number }, creds: SigCreds, otherModeCreds: SigCreds | null,
): SigDiagnosis {
  const right = correct(creds, f);
  const legacy = isLegacyScheme(creds.scheme);
  const starts = (h: string) => h.slice(0, 4) === hint.prefix;
  const tries: [SigVerdict, () => string | null][] = [
    ["CORRECT", () => right],
    ["UPPERCASE", () => right.toUpperCase()],
    ["AMOUNT_FORMAT", () => {
      const n = Number(f.amount);
      if (!Number.isFinite(n)) return null;
      const alts = [n.toFixed(2), String(n), n.toFixed(0)].filter((a) => a !== f.amount);
      for (const a of alts) { const h = correct(creds, { ...f, amount: a }); if (starts(h)) return h; }
      return null;
    }],
    ["MISSING_FIELDS", () => {
      if (!f.productinfo && !f.email) return null;
      for (const g of [{ ...f, productinfo: "", email: "" }, { ...f, productinfo: "" }, { ...f, email: "" }]) {
        const h = correct(creds, g); if (starts(h)) return h;
      }
      return null;
    }],
    ["SALT_KEY_ORDER", () => legacy ? null : hmac(creds.salt + creds.key, canonicalString(f, creds.scheme))],
    ["OTHER_MODE_SALT", () => otherModeCreds ? correct({ ...creds, salt: otherModeCreds.salt }, f) : null],
    ["PLAIN_SHA256", () => legacy ? null : sha256(canonicalString(f, creds.scheme))],
    ["SHA256_WITH_SALT", () => legacy ? null : sha256(canonicalString(f, creds.scheme) + creds.salt)],
    ["WRONG_SCHEME", () => correct({ ...creds, scheme: legacy ? "HMAC_SHA256" : "PAYU_SHA512" }, f)],
  ];
  let verdict: SigVerdict = "UNKNOWN";
  for (const [v, make] of tries) {
    const h = make();
    if (h && starts(h)) { verdict = v; break; }
  }
  return {
    verdict, should_sign: canonicalString(f, creds.scheme), scheme: legacy ? "SHA-512" : "HMAC-SHA256",
    sent_length: hint.length, expected_length: right.length, explanation: EXPLAIN[verdict],
  };
}
