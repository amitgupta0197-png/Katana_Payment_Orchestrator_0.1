// safeFetch — SSRF-hardened outbound HTTP for tenant-supplied URLs (audit H9).
//
// Merchants/providers configure webhook/callback URLs (notify_url, callback_url, channel
// target) that the server then fetches. Without egress filtering, a tenant can point those
// at internal services or the cloud metadata endpoint (169.254.169.254) and read the result
// back through the stored response body / order-timeline error oracle. safeFetch resolves the
// target host and refuses any request that resolves to a private, loopback, link-local, or
// otherwise non-public address, and permits only http/https.
//
// Residual note: this validates the resolved address before connecting; a determined
// DNS-rebinding attacker could still race the resolution. Pinning the connection to the
// validated IP (a custom undici dispatcher) is the follow-up hardening.

import { lookup } from "dns/promises";
import { isIP } from "net";

const DEFAULT_TIMEOUT_MS = 8_000;

function ipv4IsPrivate(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true; // malformed → treat as unsafe
  const [a, b] = p;
  if (a === 10) return true;                          // 10.0.0.0/8
  if (a === 127) return true;                         // loopback
  if (a === 0) return true;                           // 0.0.0.0/8
  if (a === 169 && b === 254) return true;            // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
  if (a === 192 && b === 168) return true;            // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true;  // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0) return true;              // 192.0.0.0/24 (incl. protocol assignments)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224) return true;                          // multicast / reserved
  return false;
}

function ipv6IsPrivate(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;         // loopback / unspecified
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7 unique-local
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true; // fe80::/10 link-local
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);  // IPv4-mapped
  if (mapped) return ipv4IsPrivate(mapped[1]);
  return false;
}

function ipIsPrivate(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return ipv4IsPrivate(ip);
  if (v === 6) return ipv6IsPrivate(ip);
  return true; // not a recognised IP → unsafe
}

/** Throws if `rawUrl` is not a safe public http(s) target. */
export async function assertPublicUrl(rawUrl: string): Promise<void> {
  let u: URL;
  try { u = new URL(rawUrl); } catch { throw new Error("invalid callback URL"); }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw new Error(`blocked callback scheme: ${u.protocol}`);
  const host = u.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets

  if (isIP(host)) {
    if (ipIsPrivate(host)) throw new Error(`blocked callback to non-public address: ${host}`);
    return;
  }
  // Resolve the hostname; every returned address must be public.
  let addrs: { address: string }[];
  try { addrs = await lookup(host, { all: true }); }
  catch { throw new Error(`callback host does not resolve: ${host}`); }
  if (!addrs.length) throw new Error(`callback host does not resolve: ${host}`);
  for (const a of addrs) {
    if (ipIsPrivate(a.address)) throw new Error(`blocked callback to non-public address: ${host} (${a.address})`);
  }
}

/** Drop-in fetch for tenant-supplied URLs: validates the target, then fetches with a timeout. */
export async function safeFetch(rawUrl: string, init: RequestInit = {}): Promise<Response> {
  await assertPublicUrl(rawUrl);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
  try {
    return await fetch(rawUrl, { redirect: "error", ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}
