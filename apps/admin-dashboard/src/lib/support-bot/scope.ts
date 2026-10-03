// Whose data the support bot may read in a conversation (lib/support-bot).
//
//   banker:<merchant_code>   one banker: a banker (MERCHANT persona) login, or staff testing it
//   merchant:<provider id>   a merchant (PROVIDER) and every banker mapped under it
//
// A portal user's scope comes from its session and nothing else: the request never names it.
// Staff choose one to test. The bankers in a scope are resolved again on every question, so a
// banker taken away from a merchant is out of its conversations at once.

import type { Session } from "@/lib/auth";
import { rows } from "@/lib/pg";
import { resolveProviderMerchants } from "@/lib/scope";
import { ownMerchantCode } from "@/lib/merchant-keys";
import { seesGatewayNames } from "@/lib/merchant-safe";

export type ScopeKey = `banker:${string}` | `merchant:${string}`;

export interface BotScope {
  key: ScopeKey;
  /** Who the bot is talking to, as it should address them. */
  name: string;
  /** The bankers whose data every lookup is limited to. */
  accounts: { code: string; name: string }[];
}

/** Portal personas that may use the bot. Staff use /support-bot to test. */
export const BOT_PORTAL_PERSONAS = ["PROVIDER", "MERCHANT"] as const;
export const BOT_STAFF_PERSONAS = ["SUPER_ADMIN", "ADMIN", "SUPPORT"] as const;

/** True while the bot is staff only. SUPPORT_BOT_PORTALS=1 lets merchants and bankers use it. */
export function portalsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.SUPPORT_BOT_PORTALS === "1" || env.SUPPORT_BOT_PORTALS === "true";
}

export function parseScopeKey(v: unknown): ScopeKey | null {
  const s = typeof v === "string" ? v.trim() : "";
  if (/^banker:[A-Za-z0-9_-]{1,64}$/.test(s)) return s as ScopeKey;
  if (/^merchant:[0-9a-f-]{36}$/i.test(s)) return s.toLowerCase() as ScopeKey;
  return null;
}

async function bankerNames(codes: string[]): Promise<{ code: string; name: string }[]> {
  if (!codes.length) return [];
  return rows<{ code: string; name: string }>("merchant", `
    SELECT merchant_code AS code, COALESCE(NULLIF(brand_name, ''), legal_name, merchant_code) AS name
      FROM merchants WHERE merchant_code = ANY($1::text[]) ORDER BY 2
  `, [codes]);
}

/** The bankers and name of a scope, or null when it no longer exists. */
export async function resolveScope(key: ScopeKey): Promise<BotScope | null> {
  const [kind, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
  if (kind === "banker") {
    const accounts = await bankerNames([id]);
    return accounts.length ? { key, name: accounts[0].name, accounts } : null;
  }
  const p = (await rows<{ name: string }>("provider", `
    SELECT COALESCE(NULLIF(legal_name, ''), code) AS name FROM providers WHERE id = $1::uuid
  `, [id]).catch(() => []))[0];
  if (!p) return null;
  const codes = await resolveProviderMerchants({ persona: "PROVIDER", scope_id: id } as Session);
  return { key, name: p.name, accounts: await bankerNames(codes) };
}

/** The scope a merchant or banker login talks in. Null for staff and every other persona. */
export async function sessionScopeKey(s: Session): Promise<ScopeKey | null> {
  if (seesGatewayNames(s.persona) || !s.scope_id) return null;
  if (s.persona === "PROVIDER") return parseScopeKey(`merchant:${s.scope_id}`);
  if (s.persona === "MERCHANT") {
    const code = await ownMerchantCode(s.scope_id);
    return code ? parseScopeKey(`banker:${code}`) : null;
  }
  return null;
}
