// Per-merchant TSP webhook link — generated at onboarding.
//
// Each merchant has ONE inbound callback URL on the Katana domain that their payment gateway
// / TSP posts that merchant's payment results to:
//     https://katanapay.co/api/v1/katana-pay/callback/<webhook_slug>
// The slug comes from the merchant's website (https://www.shopiva.com -> shopiva-com) and is
// stored on the merchant, never recomputed, so a link already handed out keeps working if
// the website on file changes. Rules are mirrored in the backfill migration
// tools/migrations/merchant/0008_merchant_webhook_slug.sql — change both together.
//
// Each link has its own signing secret, sealed in the credential vault. A TSP holding one
// merchant's link and secret can only ever confirm THAT merchant's orders.

import { randomBytes } from "crypto";
import { rows } from "@/lib/pg";
import { readCredential, storeCredential } from "@/lib/credential-vault";

const SECRET = { kind: "webhook_secret", ownerType: "merchant", label: "tsp_callback_secret" } as const;

const clean = (s: string) => s.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** The website's host as a slug: scheme, credentials, port, path and a leading www. removed. */
export function webhookSlugBase(website: string | null | undefined): string {
  let host = (website ?? "").trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  host = host.split("/")[0].split("?")[0].split("#")[0];
  host = host.replace(/^.*@/, "").split(":")[0].replace(/^www\./, "");
  return clean(clean(host).slice(0, 60));
}

export function webhookUrl(slug: string): string {
  const base = (process.env.PUBLIC_BASE_URL ?? "https://katanapay.co").replace(/\/$/, "");
  return `${base}/api/v1/katana-pay/callback/${slug}`;
}

/**
 * Give the merchant its webhook slug if it has none yet, and return the slug. Safe to call
 * repeatedly (onboarding, and lazily from the card for merchants created before 0008).
 */
export async function assignWebhookSlug(merchantCode: string, website: string | null | undefined): Promise<string | null> {
  const have = await rows<{ webhook_slug: string | null; id: string }>(
    "merchant", `SELECT webhook_slug, id::text FROM merchants WHERE merchant_code = $1`, [merchantCode]);
  if (!have.length) return null;
  if (have[0].webhook_slug) return have[0].webhook_slug;

  const base = webhookSlugBase(website);
  const code = clean(merchantCode.toLowerCase());
  const suffix = have[0].id.replace(/-/g, "").slice(0, 4);
  const first = base || code;
  const candidates = base ? [first, `${base}-${code}`, `${base}-${code}-${suffix}`] : [first, `${code}-${suffix}`];

  for (const cand of candidates) {
    const set = await rows<{ webhook_slug: string }>("merchant", `
      UPDATE merchants SET webhook_slug = $1
       WHERE merchant_code = $2 AND webhook_slug IS NULL
         AND NOT EXISTS (SELECT 1 FROM merchants WHERE webhook_slug = $1)
      RETURNING webhook_slug
    `, [cand, merchantCode]).catch(() => []);   // a concurrent claim trips the unique index: try the next
    if (set.length) return set[0].webhook_slug;
    const again = await rows<{ webhook_slug: string | null }>(
      "merchant", `SELECT webhook_slug FROM merchants WHERE merchant_code = $1`, [merchantCode]);
    if (again[0]?.webhook_slug) return again[0].webhook_slug;
  }
  return null;
}

export async function merchantByWebhookSlug(slug: string): Promise<{ id: string; merchant_code: string } | null> {
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) return null;
  const r = await rows<{ id: string; merchant_code: string }>(
    "merchant", `SELECT id::text, merchant_code FROM merchants WHERE webhook_slug = $1`, [slug]).catch(() => []);
  return r[0] ?? null;
}

export async function readWebhookSecret(merchantCode: string): Promise<string | null> {
  return readCredential({ ...SECRET, ownerId: merchantCode });
}

/** Generate (or rotate) the link's signing secret. Returns the plaintext ONCE. */
export async function rotateWebhookSecret(merchantCode: string): Promise<string> {
  const secret = randomBytes(32).toString("hex");
  await storeCredential({ ...SECRET, ownerId: merchantCode, plaintext: secret });
  return secret;
}
