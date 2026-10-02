// A banker's webhook settings (merchant 0014): where callbacks go, which contract they are sent
// in (v1 or v2), which outcomes are sent, and the v2 signing secret.
//
// The setting belongs to the banker (a `merchants` row), because the banker is who holds the
// API key and whose server is called. A merchant with several bankers sets each one.
//
// v1 → v2 is the banker's own choice and can be undone. Nothing here changes a banker that has
// not asked: an existing banker is v1 until it switches.
//
// v2 IS IN FORCE ONLY ONCE THE BANKER HAS A SIGNING SECRET. A banker created from now on starts
// with webhook_version = 'v2' and no secret (it is made, and shown once, in the portal). A v2
// event cannot be sent unsigned, so until the secret exists the banker is sent the v1 callback,
// signed with its Salt as ever. Nobody is left without a callback because a default changed.

import { rows } from "@/lib/pg";
import { openText, sealText } from "@/lib/sealed-text";
import { assertPublicUrl } from "@/lib/safe-fetch";
import {
  newWebhookSecret, WEBHOOK_EVENT_PREFS, WEBHOOK_VERSIONS,
  type WebhookEventPref, type WebhookVersion,
} from "@/lib/webhook-v2";

export interface WebhookSettings {
  merchant_code: string;
  name: string;
  webhook_version: WebhookVersion;
  /** What is actually being sent: v1 while a v2 banker has no signing secret yet. */
  effective_version: WebhookVersion;
  webhook_events: WebhookEventPref;
  callback_url: string | null;
  /** v2 only signs with this. Never returned; only whether one exists and its last four characters. */
  has_secret: boolean;
  secret_hint: string | null;
}

interface Row {
  merchant_code: string; name: string | null; webhook_version: string | null; webhook_events: string | null;
  webhook_url: string | null; webhook_secret: string | null;
}

const COLS = `merchant_code, COALESCE(NULLIF(brand_name, ''), legal_name) AS name,
              webhook_version, webhook_events, webhook_url, webhook_secret`;

const version = (v: string | null): WebhookVersion => (v === "v2" ? "v2" : "v1");
const events = (v: string | null): WebhookEventPref => (v === "PAID_ONLY" ? "PAID_ONLY" : "ALL");

function shape(r: Row): WebhookSettings {
  const secret = openText(r.webhook_secret);
  return {
    merchant_code: r.merchant_code, name: r.name?.trim() || r.merchant_code,
    webhook_version: version(r.webhook_version),
    effective_version: version(r.webhook_version) === "v2" && secret ? "v2" : "v1",
    webhook_events: events(r.webhook_events),
    callback_url: r.webhook_url?.trim() || null,
    has_secret: !!secret, secret_hint: secret ? `••••${secret.slice(-4)}` : null,
  };
}

export async function listWebhookSettings(merchantCodes: string[]): Promise<WebhookSettings[]> {
  if (!merchantCodes.length) return [];
  const r = await rows<Row>("merchant",
    `SELECT ${COLS} FROM merchants WHERE merchant_code = ANY($1::text[]) ORDER BY merchant_code`, [merchantCodes]);
  return r.map(shape);
}

/**
 * What the callback sender needs for one banker. `version` is the one in force: v2 only with a
 * signing secret. A database without the columns yet (merchant 0014 not applied) answers
 * v1 / ALL, which is what every banker was before them.
 */
export async function webhookDelivery(merchantCode: string): Promise<{ version: WebhookVersion; events: WebhookEventPref; url: string | null; hasSecret: boolean }> {
  try {
    const r = await rows<Row>("merchant", `SELECT ${COLS} FROM merchants WHERE merchant_code = $1`, [merchantCode]);
    if (!r.length) return { version: "v1", events: "ALL", url: null, hasSecret: false };
    const s = shape(r[0]);
    const u = s.callback_url;
    return { version: s.effective_version, events: s.webhook_events, url: u && /^https?:\/\//i.test(u) ? u : null, hasSecret: s.has_secret };
  } catch (err) {
    if ((err as { code?: string }).code !== "42703") throw err;
    const r = await rows<{ webhook_url: string | null }>("merchant",
      `SELECT webhook_url FROM merchants WHERE merchant_code = $1`, [merchantCode]).catch(() => []);
    const u = r[0]?.webhook_url?.trim();
    return { version: "v1", events: "ALL", url: u && /^https?:\/\//i.test(u) ? u : null, hasSecret: false };
  }
}

export interface WebhookSettingsChange {
  webhook_version?: WebhookVersion;
  webhook_events?: WebhookEventPref;
  /** "" clears it. */
  callback_url?: string;
}

/**
 * Save a banker's settings. Moving to v2 makes a signing secret when the banker has none; that
 * secret is returned here, once, and is not readable afterwards.
 */
export async function saveWebhookSettings(merchantCode: string, c: WebhookSettingsChange, by: string):
  Promise<{ ok: true; settings: WebhookSettings; secret?: string } | { ok: false; error: string }> {
  if (c.webhook_version && !(WEBHOOK_VERSIONS as readonly string[]).includes(c.webhook_version)) return { ok: false, error: "webhook_version is v1 or v2" };
  if (c.webhook_events && !(WEBHOOK_EVENT_PREFS as readonly string[]).includes(c.webhook_events)) return { ok: false, error: "webhook_events is ALL or PAID_ONLY" };
  const url = c.callback_url?.trim();
  if (url) {
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: "callback_url must be an http(s) address" };
    try { await assertPublicUrl(url); } catch (e) { return { ok: false, error: (e as Error).message }; }
  }

  const cur = (await rows<Row>("merchant", `SELECT ${COLS} FROM merchants WHERE merchant_code = $1`, [merchantCode]))[0];
  if (!cur) return { ok: false, error: "banker not found" };
  const before = shape(cur);
  const nextVersion = c.webhook_version ?? before.webhook_version;
  const secret = nextVersion === "v2" && !before.has_secret ? newWebhookSecret() : undefined;

  await rows("merchant", `
    UPDATE merchants SET
      webhook_version = $2,
      webhook_events  = $3,
      webhook_url     = CASE WHEN $4::boolean THEN NULLIF($5, '') ELSE webhook_url END,
      webhook_secret  = COALESCE($6, webhook_secret),
      webhook_version_set_by = CASE WHEN webhook_version IS DISTINCT FROM $2 THEN $7 ELSE webhook_version_set_by END,
      webhook_version_set_at = CASE WHEN webhook_version IS DISTINCT FROM $2 THEN now() ELSE webhook_version_set_at END,
      updated_at = now()
    WHERE merchant_code = $1
  `, [merchantCode, nextVersion, c.webhook_events ?? before.webhook_events, c.callback_url !== undefined, url ?? "",
      secret ? sealText(secret) : null, by]);

  const after = (await listWebhookSettings([merchantCode]))[0];
  return { ok: true, settings: after, ...(secret ? { secret } : {}) };
}

/** Replace the v2 signing secret. The old one stops verifying at once. Returned once. */
export async function rotateWebhookSecret(merchantCode: string): Promise<string | null> {
  const secret = newWebhookSecret();
  const r = await rows("merchant",
    `UPDATE merchants SET webhook_secret = $2, updated_at = now() WHERE merchant_code = $1 RETURNING 1`,
    [merchantCode, sealText(secret)]);
  return r.length ? secret : null;
}
