// Is this mail really from the payment provider it says it is from? Pure.
//
// A "payment received" mail from a linked mailbox can mark an order paid, so who sent it is
// the whole question. The old test was a keyword anywhere in the sender OR THE SUBJECT, which
// anyone can type. A mail is now trusted only when both of these hold:
//
//   1. its From address is at a payment provider's own domain (the list below, extended by
//      PAYMENT_EMAIL_DOMAINS), and
//   2. the receiving mail server authenticated that domain: its Authentication-Results header
//      says DMARC passed for it, or DKIM passed with a signature of that same domain.
//
// WHOSE HEADER. A sender can put any header in a mail, including a forged
// Authentication-Results. The receiving server writes its own on top of everything it was
// handed, so only the FIRST one is read, and only when it names that server (mx.google.com
// for Gmail, which is where the mailboxes are). A mailbox on another service has no header
// this code trusts and its mail is not trusted.

export interface MailHeader { name: string; value: string }

// Sender domains of the providers whose payment mails are parsed. A subdomain of one counts.
const DEFAULT_DOMAINS = ["bharatpe.in", "bharatpe.com", "paytm.com", "paytmbank.com", "phonepe.com", "razorpay.com"];

export function paymentEmailDomains(env: Record<string, string | undefined> = process.env): string[] {
  const extra = (env.PAYMENT_EMAIL_DOMAINS ?? "").split(",").map((d) => d.trim().toLowerCase()).filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d));
  return [...new Set([...DEFAULT_DOMAINS, ...extra])];
}

/** The server whose Authentication-Results header is believed (EMAIL_AUTHSERV_ID, default Gmail's). */
export const authservId = (env: Record<string, string | undefined> = process.env) => (env.EMAIL_AUTHSERV_ID ?? "mx.google.com").toLowerCase();

/** `enforce` (default): an unverified mail is not acted on. `report`: it is, and the failure is only recorded. */
export const senderCheckMode = (env: Record<string, string | undefined> = process.env): "enforce" | "report" =>
  env.EMAIL_SENDER_CHECK === "report" ? "report" : "enforce";

/** The domain of a From header's address: `BharatPe <noreply@bharatpe.in>` → `bharatpe.in`. */
export function fromDomain(from: string): string | null {
  // The address is what is inside the LAST angle brackets; a display name may itself hold an
  // address ("paytm@paytm.com" <attacker@evil.example>) and is only a label.
  const angle = [...from.matchAll(/<([^<>]*)>/g)].pop()?.[1];
  const addr = (angle ?? from).trim().toLowerCase();
  const m = /^[^\s@<>"]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/.exec(addr);
  return m ? m[1] : null;
}

const under = (domain: string, parent: string) => domain === parent || domain.endsWith("." + parent);

export interface SenderVerdict {
  trusted: boolean;
  domain: string | null;
  /** Why not, in a few words; null when trusted. */
  reason: string | null;
}

export function checkSender(headers: MailHeader[], domains: string[] = paymentEmailDomains(), server: string = authservId()): SenderVerdict {
  const fromHeaders = headers.filter((h) => h.name.toLowerCase() === "from");
  // Two From headers is a mail built to show one sender and authenticate another.
  if (fromHeaders.length !== 1) return { trusted: false, domain: null, reason: fromHeaders.length ? "more than one From header" : "no From header" };
  const domain = fromDomain(fromHeaders[0].value);
  if (!domain) return { trusted: false, domain: null, reason: "From address not readable" };
  const provider = domains.find((d) => under(domain, d));
  if (!provider) return { trusted: false, domain, reason: `${domain} is not a payment provider's domain` };

  const ar = headers.find((h) => h.name.toLowerCase() === "authentication-results");
  if (!ar) return { trusted: false, domain, reason: "the mail server recorded no authentication result" };
  const value = ar.value.replace(/\s+/g, " ").toLowerCase();
  if (value.split(";")[0].trim().split(" ")[0] !== server)
    return { trusted: false, domain, reason: "the top authentication result is not the mailbox's own server's" };

  // dmarc=pass … header.from=<domain>: the From domain itself was authenticated.
  const dmarc = /\bdmarc=pass\b[^;]*?\bheader\.from=([a-z0-9.-]+)/.exec(value)?.[1];
  if (dmarc && (under(domain, dmarc) || under(dmarc, provider))) return { trusted: true, domain, reason: null };
  // dkim=pass with a signature of the provider's own domain (header.i=@domain or header.d=domain).
  for (const m of value.matchAll(/\bdkim=pass\b[^;]*?\bheader\.(?:i=[^\s;]*@|d=)([a-z0-9.-]+)/g))
    if (under(m[1], provider)) return { trusted: true, domain, reason: null };
  return { trusted: false, domain, reason: `the mail server did not authenticate ${domain}` };
}
