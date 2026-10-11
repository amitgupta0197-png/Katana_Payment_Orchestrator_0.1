// Testing a payment account's credentials BEFORE they are saved (banker wizard, "Test
// connection"). No connector has a ping, so each is asked something harmless with the entered
// credentials and its answer is read: an authentication error means the credentials are wrong; any
// other answer ("no such order", a payment page) means the gateway accepted them. Pure: the
// reading of answers. The calls are in lib/credential-test-run.

export type CredResult = "OK" | "WRONG" | "WARN" | "UNKNOWN";
export interface CredVerdict { result: CredResult; message: string }

const AUTH_RX = /(invalid|incorrect|wrong|bad)\s*(hash|signature|key|secret|credential|client|token|merchant|app ?id|api)|unauthori[sz]ed|authentication|forbidden|access denied|not authori[sz]ed|\b401\b|\b403\b|signature (mismatch|verification failed)/i;
const NETWORK_RX = /unreachable|timed? ?out|ECONN|ENOTFOUND|network|fetch failed|non-JSON/i;

/** A gateway's answer to "what about order <made-up id>?", read for the credentials. */
export function readStatusAnswer(gatewayName: string, a: { ok: true } | { ok: false; error: string }): CredVerdict {
  if (a.ok) return { result: "OK", message: `${gatewayName} accepted these credentials.` };
  const e = a.error || "";
  if (AUTH_RX.test(e)) return { result: "WRONG", message: `${gatewayName} refused these credentials: ${e}` };
  if (NETWORK_RX.test(e)) return { result: "UNKNOWN", message: `Couldn't reach ${gatewayName} to check: ${e}` };
  // "not found", "no such order", "transaction does not exist": the gateway knew who we were.
  return { result: "OK", message: `${gatewayName} answered with these credentials (the test order is unknown to it, as expected).` };
}

/** PayU's verify_payment answer (lib/payu-verify) for a made-up txnid. */
export function readPayuVerify(status: string): CredVerdict {
  if (/invalid hash|invalid key|merchant key|not authori/i.test(status)) return { result: "WRONG", message: `PayU refused the Key + Salt (${status}).` };
  if (/^http_|unparseable/.test(status)) return { result: "UNKNOWN", message: `Couldn't read PayU's answer (${status}).` };
  return { result: "OK", message: "PayU accepted the Key + Salt." };
}

/** PayAtom's answer to one signed request.php call. */
export function readPayatomAnswer(httpStatus: number, body: { status?: string; message?: string } | null): CredVerdict {
  const msg = String(body?.message ?? "");
  if (body?.status === "success") return { result: "OK", message: "PayAtom accepted the PID, secret key and API key (it now holds one unpaid ₹201 test request)." };
  if (/invalid signature/i.test(msg)) return { result: "WRONG", message: "PayAtom says the signature is wrong: the secret key doesn't match this PID." };
  if (/ip|whitelist/i.test(msg)) return { result: "WRONG", message: `PayAtom refused the server's IP: ask PayAtom to whitelist 72.61.227.233 (${msg}).` };
  if (/api.?key|unauthori|forbidden/i.test(msg) || httpStatus === 401 || httpStatus === 403) return { result: "WRONG", message: `PayAtom refused the API key (${msg || "HTTP " + httpStatus}).` };
  if (/channel/i.test(msg)) return { result: "WARN", message: `Credentials accepted, but PayAtom has no payment channel on this PID yet: "${msg}". Ask PayAtom to map one.` };
  if (/amount|greater than/i.test(msg)) return { result: "OK", message: `PayAtom accepted the credentials (it only objected to the test amount: "${msg}").` };
  return { result: "UNKNOWN", message: msg ? `PayAtom answered: "${msg}"` : `PayAtom answered HTTP ${httpStatus}.` };
}
