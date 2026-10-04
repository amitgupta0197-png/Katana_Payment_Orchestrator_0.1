// Storage for the banker switch (lib/banker-switch, vendorGateway 0042): per merchant settings,
// per banker rotation, the append-only event log, and what the screens show about each banker.
// Imports no order code, so lib/katana-order can import it.

import { rows } from "@/lib/pg";
import { providerForMerchant } from "@/lib/provider-integration";
import {
  DEFAULT_BANKER_SWITCH, defaultMember, type BankerMember, type BankerSwitchMode, type BankerSwitchSettings,
} from "@/lib/banker-switch";

/** Before 0042 is applied there is no switch, and orders go exactly as before. */
const missing = (err: unknown) => ["42P01", "42703"].includes((err as { code?: string }).code ?? "");

export interface ProviderBanker { code: string; name: string }

/** The merchant's bankers (active mappings), by code, with the name shown on screens. */
export async function providerBankers(providerId: string): Promise<ProviderBanker[]> {
  const map = await rows<{ merchant_id: string }>("provider", `
    SELECT merchant_id::text AS merchant_id FROM provider_merchant_mappings
     WHERE provider_id = $1::uuid AND status = 'ACTIVE'`, [providerId]).catch(() => []);
  if (!map.length) return [];
  const ids = map.map((m) => m.merchant_id);
  return rows<ProviderBanker>("merchant", `
    SELECT merchant_code AS code, COALESCE(NULLIF(brand_name,''), legal_name, merchant_code) AS name
      FROM merchants
     WHERE (id::text = ANY($1::text[]) OR merchant_code = ANY($1::text[])) AND merchant_code IS NOT NULL
     ORDER BY 2, 1`, [ids]).catch(() => []);
}

export async function getSwitchSettings(providerId: string): Promise<BankerSwitchSettings> {
  const r = await rows<BankerSwitchSettings>("vendorGateway", `
    SELECT enabled, mode, pinned_banker, pinned_until::text AS pinned_until, pin_reason, last_banker
      FROM payin_banker_switch WHERE provider_id = $1`, [providerId]).catch((e) => { if (missing(e)) return []; throw e; });
  return r[0] ?? { ...DEFAULT_BANKER_SWITCH };
}

/** Every banker of the merchant as a member: its own row, or in rotation by default. */
export async function getMembers(providerId: string, bankers: string[]): Promise<BankerMember[]> {
  const r = await rows<BankerMember>("vendorGateway", `
    SELECT banker_code, in_rotation, priority, weight FROM payin_banker_switch_members WHERE provider_id = $1`, [providerId])
    .catch((e) => { if (missing(e)) return []; throw e; });
  return bankers.map((b) => r.find((m) => m.banker_code === b) ?? defaultMember(b));
}

export interface SignerSwitch { providerId: string; settings: BankerSwitchSettings; members: BankerMember[] }

/**
 * The switch an order signed by this banker goes through, or null when its merchant has none on
 * (or it has no merchant, or only one banker): the order is then the signer's, as before.
 */
export async function switchForSigner(signer: string): Promise<SignerSwitch | null> {
  const providerId = await providerForMerchant(signer);
  if (!providerId) return null;
  const settings = await getSwitchSettings(providerId);
  if (!settings.enabled) return null;
  const bankers = (await providerBankers(providerId)).map((b) => b.code);
  if (bankers.length < 2 || !bankers.includes(signer)) return null;
  return { providerId, settings, members: await getMembers(providerId, bankers) };
}

/** Which of these bankers hold a Key for this mode: an order is only given to one that does. */
export async function bankersWithKey(codes: string[], livemode: boolean): Promise<Set<string>> {
  const r = await rows<{ merchant_code: string }>("checkout", `
    SELECT DISTINCT merchant_code FROM merchant_checkout_keys WHERE merchant_code = ANY($1::text[]) AND livemode = $2`,
    [codes, livemode]).catch(() => []);
  return new Set(r.map((x) => x.merchant_code));
}

/** Orders each banker took today (India day), for the PRIORITY tie-break and the screens. */
export async function bankerToday(codes: string[], livemode: boolean): Promise<Record<string, { orders: number; amount: number; paid: number }>> {
  const r = await rows<{ b: string; orders: number; amount: string; paid: string }>("vendorGateway", `
    SELECT merchant_id AS b, COUNT(*)::int AS orders, COALESCE(SUM(amount),0)::text AS amount,
           COALESCE(SUM(amount) FILTER (WHERE status = 'SUCCESS'),0)::text AS paid
      FROM vendor_payin_orders
     WHERE vendor = 'KATANA' AND merchant_id = ANY($1::text[]) AND livemode = $2
       AND created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'
     GROUP BY 1`, [codes, livemode]).catch(() => []);
  return Object.fromEntries(r.map((x) => [x.b, { orders: x.orders, amount: Number(x.amount), paid: Number(x.paid) }]));
}

export async function logSwitchEvent(providerId: string, action: string, actor: string, banker: string | null, detail: Record<string, unknown> = {}): Promise<void> {
  await rows("vendorGateway", `
    INSERT INTO payin_banker_switch_events (provider_id, banker_code, action, detail, actor) VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [providerId, banker, action, JSON.stringify(detail), actor]).catch((e) => { if (!missing(e)) throw e; });
}

/** Note the banker that took an order; logs AUTO_SWITCH when traffic moved to another banker. */
export async function noteTaken(providerId: string, banker: string, detail: Record<string, unknown>): Promise<void> {
  const moved = await rows<{ prev: string | null }>("vendorGateway", `
    WITH p AS (SELECT last_banker AS prev FROM payin_banker_switch WHERE provider_id = $1)
    UPDATE payin_banker_switch s SET last_banker = $2 FROM p
     WHERE s.provider_id = $1 AND s.last_banker IS DISTINCT FROM $2
     RETURNING p.prev`, [providerId, banker]).catch(() => []);
  if (moved.length) await logSwitchEvent(providerId, "AUTO_SWITCH", "switch", banker, { ...detail, from: moved[0].prev });
}

export interface SwitchEvent { at: string; action: string; banker_code: string | null; actor: string; detail: Record<string, unknown> }

export async function listSwitchEvents(providerId: string, limit = 40): Promise<SwitchEvent[]> {
  return rows<SwitchEvent>("vendorGateway", `
    SELECT at::text AS at, action, banker_code, actor, detail FROM payin_banker_switch_events
     WHERE provider_id = $1 ORDER BY at DESC, id DESC LIMIT $2`, [providerId, limit])
    .catch((e) => { if (missing(e)) return []; throw e; });
}

async function ensureRow(providerId: string): Promise<void> {
  await rows("vendorGateway", `INSERT INTO payin_banker_switch (provider_id) VALUES ($1) ON CONFLICT DO NOTHING`, [providerId]);
}

export async function saveSwitchSettings(providerId: string, s: { enabled?: boolean; mode?: BankerSwitchMode }, actor: string): Promise<void> {
  await ensureRow(providerId);
  await rows("vendorGateway", `
    UPDATE payin_banker_switch SET enabled = COALESCE($2::boolean, enabled), mode = COALESCE($3::text, mode), updated_at = now(), updated_by = $4
     WHERE provider_id = $1`, [providerId, s.enabled ?? null, s.mode ?? null, actor]);
  await logSwitchEvent(providerId, "SETTINGS", actor, null, s);
}

export async function saveMember(providerId: string, banker: string, m: { in_rotation?: boolean; priority?: number; weight?: number }, actor: string): Promise<void> {
  const d = defaultMember(banker);
  await rows("vendorGateway", `
    INSERT INTO payin_banker_switch_members (provider_id, banker_code, in_rotation, priority, weight, updated_by)
    VALUES ($1, $2, COALESCE($3::boolean, $6::boolean), COALESCE($4::int, $7::int), COALESCE($5::int, $8::int), $9)
    ON CONFLICT (provider_id, banker_code) DO UPDATE SET
      in_rotation = COALESCE($3::boolean, payin_banker_switch_members.in_rotation),
      priority    = COALESCE($4::int, payin_banker_switch_members.priority),
      weight      = COALESCE($5::int, payin_banker_switch_members.weight),
      updated_at = now(), updated_by = $9`,
    [providerId, banker, m.in_rotation ?? null, m.priority ?? null, m.weight ?? null, d.in_rotation, d.priority, d.weight, actor]);
  await logSwitchEvent(providerId, "MEMBER", actor, banker, m);
}

/** The manual switch: every order to this banker (optionally for some minutes), or released (null). */
export async function pinBanker(providerId: string, banker: string | null, minutes: number | null, reason: string | null, actor: string): Promise<void> {
  await ensureRow(providerId);
  await rows("vendorGateway", `
    UPDATE payin_banker_switch SET pinned_banker = $2,
           pinned_until = CASE WHEN $2::text IS NULL OR $3::int IS NULL THEN NULL ELSE now() + make_interval(mins => $3::int) END,
           pin_reason = CASE WHEN $2::text IS NULL THEN NULL ELSE $4 END, updated_at = now(), updated_by = $5
     WHERE provider_id = $1`, [providerId, banker, minutes, reason, actor]);
  await logSwitchEvent(providerId, banker ? "PINNED" : "UNPINNED", actor, banker, banker ? { minutes, reason } : {});
}
