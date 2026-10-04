// The MID switch's data (vendorGateway 0040): a banker's MIDs, their usage and health, the
// switch settings, and the log of every change and every automatic switch. The decision itself
// is lib/mid-switch (pure).
//
// Usage is counted from the orders each MID took (vendor_payin_orders.payin_mid_id), live only,
// India-time day and month; failed and expired orders give their amount back. The check made
// when the MID is picked is read without a lock; insertOrderWithinLimits takes the banker's and
// the MID's locks, reads the usage again and inserts, so orders arriving together cannot pass a
// limit between them.

import type { PoolClient } from "pg";
import { db, rows } from "@/lib/pg";
import { PayinLimitError, dailyBreach } from "@/lib/payin-limits";
import { setAlert } from "@/lib/ops-alert";
import { vpasFromConfig } from "@/lib/settlement-vpa";
import { getGatewayMid, VAULT_LABEL } from "@/lib/gateway-creds";
import {
  chooseMid, DEFAULT_SETTINGS, healthRuleFromEnv, NoMidAvailableError, validateMidLimits, type Candidate, type Choice, type Mid,
  type MidHealth, type MidKind, type MidMode, type MidSettings, type MidUsage,
} from "@/lib/mid-switch";

const MID_COLS = `id::text, banker_code, kind, name, vault_label, upi_id, payee_name, priority, weight, status, status_reason,
  min_amount::float AS min_amount, max_amount::float AS max_amount, daily_amount::float AS daily_amount, daily_count,
  monthly_amount::float AS monthly_amount, to_char(active_from, 'HH24:MI') AS active_from, to_char(active_to, 'HH24:MI') AS active_to,
  active_days, skip_unhealthy, health_min_success`;

export async function listMids(banker: string, kind?: MidKind): Promise<Mid[]> {
  return rows<Mid>("vendorGateway", `
    SELECT ${MID_COLS} FROM payin_mids WHERE banker_code = $1 ${kind ? "AND kind = $2" : ""}
     ORDER BY kind, priority, created_at`, kind ? [banker, kind] : [banker]);
}

export async function getMid(id: string): Promise<Mid | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return (await rows<Mid>("vendorGateway", `SELECT ${MID_COLS} FROM payin_mids WHERE id = $1::uuid`, [id]))[0] ?? null;
}

const IST_DAY = `(date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`;
const IST_MONTH = `(date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`;

const USAGE_SQL = `
  SELECT payin_mid_id::text AS id,
         COALESCE(SUM(amount) FILTER (WHERE created_at >= ${IST_DAY}), 0)::float AS day_amount,
         COUNT(*) FILTER (WHERE created_at >= ${IST_DAY})::int AS day_count,
         COALESCE(SUM(amount), 0)::float AS month_amount
    FROM vendor_payin_orders
   WHERE payin_mid_id = ANY($1::uuid[]) AND livemode AND status NOT IN ('FAILED','EXPIRED')
     AND created_at >= ${IST_MONTH}
   GROUP BY 1`;

export async function midUsage(ids: string[], client?: PoolClient): Promise<Map<string, MidUsage>> {
  const out = new Map<string, MidUsage>(ids.map((id) => [id, { day_amount: 0, day_count: 0, month_amount: 0 }]));
  if (!ids.length) return out;
  const r = client
    ? (await client.query<{ id: string } & MidUsage>(USAGE_SQL, [ids])).rows
    : await rows<{ id: string } & MidUsage>("vendorGateway", USAGE_SQL, [ids]);
  for (const x of r) out.set(x.id, { day_amount: Number(x.day_amount), day_count: Number(x.day_count), month_amount: Number(x.month_amount) });
  return out;
}

/** Recent outcomes per MID: ended live orders of the last 6 hours, and create failures of the last 10 minutes. */
export async function midHealth(ids: string[]): Promise<Map<string, MidHealth>> {
  const out = new Map<string, MidHealth>(ids.map((id) => [id, { ended: 0, paid: 0, recent_create_failures: 0 }]));
  if (!ids.length) return out;
  const [ended, failures] = await Promise.all([
    rows<{ id: string; ended: number; paid: number }>("vendorGateway", `
      SELECT payin_mid_id::text AS id, COUNT(*)::int AS ended,
             COUNT(*) FILTER (WHERE status IN ('SUCCESS','SUCCEEDED'))::int AS paid
        FROM vendor_payin_orders
       WHERE payin_mid_id = ANY($1::uuid[]) AND livemode AND created_at >= now() - interval '6 hours'
         AND status IN ('SUCCESS','SUCCEEDED','FAILED','EXPIRED')
       GROUP BY 1`, [ids]),
    rows<{ id: string; n: number }>("vendorGateway", `
      SELECT mid_id::text AS id, COUNT(*)::int AS n FROM payin_mid_events
       WHERE mid_id = ANY($1::uuid[]) AND action = 'CREATE_FAILED' AND at >= now() - interval '10 minutes'
       GROUP BY 1`, [ids]),
  ]);
  for (const e of ended) out.set(e.id, { ...out.get(e.id)!, ended: e.ended, paid: e.paid });
  for (const f of failures) out.set(f.id, { ...out.get(f.id)!, recent_create_failures: f.n });
  return out;
}

export interface StoredSettings extends MidSettings { last_mid_id: string | null; pinned_by: string | null; pin_reason: string | null; updated_by: string | null; updated_at: string | null }

export async function getSettings(banker: string, kind: MidKind): Promise<StoredSettings> {
  const r = await rows<StoredSettings>("vendorGateway", `
    SELECT enabled, mode, pinned_mid_id::text, pinned_until, last_mid_id::text, pinned_by, pin_reason, updated_by, updated_at
      FROM payin_mid_settings WHERE banker_code = $1 AND kind = $2`, [banker, kind]);
  const s = r[0];
  if (!s) return { ...DEFAULT_SETTINGS, last_mid_id: null, pinned_by: null, pin_reason: null, updated_by: null, updated_at: null };
  return { ...s, pinned_until: s.pinned_until ? new Date(s.pinned_until).toISOString() : null };
}

export async function logMidEvent(e: { banker: string; kind?: MidKind | null; midId?: string | null; action: string; detail?: Record<string, unknown>; actor: string }): Promise<void> {
  await rows("vendorGateway", `
    INSERT INTO payin_mid_events (banker_code, kind, mid_id, action, detail, actor) VALUES ($1, $2, $3::uuid, $4, $5::jsonb, $6)
  `, [e.banker, e.kind ?? null, e.midId ?? null, e.action, JSON.stringify(e.detail ?? {}), e.actor]).catch((err) => {
    console.warn("[mid-switch] event not logged:", (err as Error).message);
  });
}

/** Every MID of a banker with today's usage and its health, for the screens. */
export async function midsWithState(banker: string): Promise<{ mids: (Mid & { usage: MidUsage; health: MidHealth })[] }> {
  const mids = await listMids(banker);
  const ids = mids.map((m) => m.id);
  const [usage, health] = await Promise.all([midUsage(ids), midHealth(ids)]);
  return { mids: mids.map((m) => ({ ...m, usage: usage.get(m.id)!, health: health.get(m.id)! })) };
}

export interface MidPick {
  mid: Mid;
  choice: Choice;
  /** The other MIDs that could take the order, best first (a P2P order keeps them as its backup UPI IDs). */
  others: Mid[];
}

/**
 * The MID that takes a live order of `amount` for this banker and kind, or null when the banker
 * has no MIDs of that kind (or has switched the switch off): it is then routed as before.
 * Throws NoMidAvailableError when it has MIDs and none can take the order.
 */
export async function pickMidForOrder(banker: string, kind: MidKind, amount: number, exclude: string[] = []): Promise<MidPick | null> {
  const [mids, settings] = await Promise.all([listMids(banker, kind), getSettings(banker, kind)]);
  if (!mids.length || !settings.enabled) return null;
  const ids = mids.map((m) => m.id);
  const [usage, health] = await Promise.all([midUsage(ids), midHealth(ids)]);
  const cands: Candidate[] = mids.map((m) => ({ mid: m, usage: usage.get(m.id)!, health: health.get(m.id)! }));
  const now = new Date();
  const choice = chooseMid(cands, settings, amount, now, { exclude, rule: healthRuleFromEnv() });

  const alertKey = `mid:none:${banker}:${kind}`;
  if (!choice.chosen) {
    await logMidEvent({ banker, kind, action: "NONE_AVAILABLE", actor: "switch",
      detail: { amount, evaluated: choice.evaluated.map((e) => ({ name: e.name, why_not: e.why_not })) } });
    await setAlert(true, {
      key: alertKey, severity: "WARN", repeatMinutes: 30,
      title: `${banker}: no ${kind === "GATEWAY" ? "processor account" : "UPI ID"} can take pay-ins`,
      body: choice.evaluated.map((e) => `${e.name}: ${e.why_not.join("; ")}`).join("\n"),
    }).catch(() => {});
    throw new NoMidAvailableError(banker, kind, choice.evaluated);
  }
  const chosen = choice.chosen;
  if (settings.last_mid_id !== chosen.id) {
    // Traffic moved: say why, once, when it happens.
    if (settings.last_mid_id && choice.how !== "MANUAL") {
      const from = mids.find((m) => m.id === settings.last_mid_id);
      await logMidEvent({ banker, kind, midId: chosen.id, action: "AUTO_SWITCH", actor: "switch",
        detail: { from: from?.name ?? null, to: chosen.name, reason: choice.reason,
                  from_why_not: choice.evaluated.find((e) => e.id === settings.last_mid_id)?.why_not ?? [] } });
    }
    await rows("vendorGateway", `
      INSERT INTO payin_mid_settings (banker_code, kind, last_mid_id) VALUES ($1, $2, $3::uuid)
      ON CONFLICT (banker_code, kind) DO UPDATE SET last_mid_id = EXCLUDED.last_mid_id
    `, [banker, kind, chosen.id]).catch(() => {});
  }
  await setAlert(false, { key: alertKey, severity: "WARN", title: "" }).catch(() => {});
  const others = choice.evaluated.filter((e) => e.eligible && e.id !== chosen.id)
    .map((e) => mids.find((m) => m.id === e.id)!).sort((a, b) => a.priority - b.priority);
  return { mid: chosen, choice, others };
}

/** An order could not be created on this MID (the processor refused or failed). Counts against its health. */
export async function recordCreateFailure(mid: Mid, error: string): Promise<void> {
  await logMidEvent({ banker: mid.banker_code, kind: mid.kind, midId: mid.id, action: "CREATE_FAILED", actor: "switch",
    detail: { error: error.slice(0, 300) } });
}

const BANKER_DAY_SQL = `
  SELECT COALESCE(SUM(amount), 0)::text AS day_amount
    FROM vendor_payin_orders
   WHERE vendor = 'KATANA' AND merchant_id = $1 AND livemode AND status NOT IN ('FAILED','EXPIRED')
     AND created_at >= ${IST_DAY}`;

/**
 * Insert a live order only if the banker's day (when it has a daily limit) and the MID's limits
 * still have room for it. Locks are taken banker first, then MID, so two orders never wait on
 * each other in opposite orders. Throws PayinLimitError for the banker's day and
 * NoMidAvailableError for the MID: the order is refused rather than sent over a limit.
 */
export async function insertOrderWithinLimits<T>(input: {
  banker: string; amount: number; bankerDaily: number | null; mid: Mid | null; sql: string; args: unknown[];
}): Promise<T[]> {
  const midLimited = !!input.mid && (input.mid.daily_amount != null || input.mid.daily_count != null || input.mid.monthly_amount != null);
  const client = await db("vendorGateway").connect();
  try {
    await client.query("BEGIN");
    if (input.bankerDaily != null) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`payin-day:${input.banker}`]);
      const used = Number((await client.query<{ day_amount: string }>(BANKER_DAY_SQL, [input.banker])).rows[0]?.day_amount ?? 0);
      const breach = dailyBreach(input.amount, used, input.bankerDaily);
      if (breach) throw new PayinLimitError(breach);
    }
    if (midLimited) {
      const m = input.mid!;
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`payin-mid:${m.id}`]);
      const u = (await midUsage([m.id], client)).get(m.id)!;
      const over = (m.daily_amount != null && u.day_amount + input.amount > m.daily_amount + 0.005)
        || (m.daily_count != null && u.day_count + 1 > m.daily_count)
        || (m.monthly_amount != null && u.month_amount + input.amount > m.monthly_amount + 0.005);
      if (over) throw new NoMidAvailableError(input.banker, m.kind, [{ id: m.id, name: m.name, eligible: false, why_not: ["its limit was reached by orders made at the same moment"], health: "UNKNOWN", success_pct: null }]);
    }
    const r = await client.query(input.sql, input.args as any[]);
    await client.query("COMMIT");
    return r.rows as T[];
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── Managing MIDs ───────────────────────────────────────────────────────────────────────────────

export class MidSwitchError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** The UPI IDs set up on the banker's payment config: the only ones that can be a UPI MID. */
export async function bankerUpiIds(banker: string): Promise<string[]> {
  const r = await rows<{ katana_pay: unknown }>("merchant",
    `SELECT katana_pay FROM merchant_payment_config WHERE merchant_code = $1`, [banker]).catch(() => []);
  return vpasFromConfig(r[0]?.katana_pay);
}

/** The banker's gateway accounts in the vault (staff only: the gateway is named). */
export async function bankerGatewayAccounts(banker: string): Promise<{ vault_label: string; gateway: string; env: string; mid_code: string }[]> {
  const list = await rows<{ label: string }>("checkout", `
    SELECT DISTINCT label FROM credential_vault
     WHERE kind = 'mid_secret' AND owner_type = 'merchant' AND owner_id = $1 AND enabled = true
       AND (label = $2 OR label LIKE $3)`, [banker, VAULT_LABEL, `${VAULT_LABEL}:%`]).catch(() => []);
  const out: { vault_label: string; gateway: string; env: string; mid_code: string }[] = [];
  for (const l of list) {
    const m = await getGatewayMid(banker, l.label).catch(() => null);
    if (m) out.push({ vault_label: l.label, gateway: m.gateway, env: m.env ?? "TEST", mid_code: m.mid_code });
  }
  return out.sort((a, b) => (a.vault_label === VAULT_LABEL ? -1 : b.vault_label === VAULT_LABEL ? 1 : a.vault_label.localeCompare(b.vault_label)));
}

export interface MidFields {
  name?: string; payee_name?: string | null; priority?: number; weight?: number;
  min_amount?: number | null; max_amount?: number | null; daily_amount?: number | null; daily_count?: number | null;
  monthly_amount?: number | null; active_from?: string | null; active_to?: string | null; active_days?: number[] | null;
  skip_unhealthy?: boolean; health_min_success?: number | null;
}

const FIELD_COLS: (keyof MidFields)[] = ["name", "payee_name", "priority", "weight", "min_amount", "max_amount", "daily_amount",
  "daily_count", "monthly_amount", "active_from", "active_to", "active_days", "skip_unhealthy", "health_min_success"];

/** Add a MID: a UPI ID set up on the banker, or one of its gateway accounts in the vault. */
export async function addMid(input: { banker: string; kind: MidKind; upi_id?: string | null; vault_label?: string | null } & MidFields, actor: string): Promise<Mid> {
  if (input.kind === "UPI") {
    const upi = (input.upi_id ?? "").trim().toLowerCase();
    if (!(await bankerUpiIds(input.banker)).includes(upi)) throw new MidSwitchError(422, "that UPI ID is not set up on this account; ask Katana to add it first");
  } else {
    if (!input.vault_label || !(await bankerGatewayAccounts(input.banker)).some((a) => a.vault_label === input.vault_label)) {
      throw new MidSwitchError(422, "no such processor account on this account");
    }
  }
  const bad = validateMidLimits(input);
  if (bad) throw new MidSwitchError(400, bad);
  const existing = await listMids(input.banker, input.kind);
  const name = input.name?.trim() || (input.kind === "UPI" ? input.upi_id!.trim().toLowerCase() : `Processor account ${existing.length + 1}`);
  const r = await rows<{ id: string }>("vendorGateway", `
    INSERT INTO payin_mids (banker_code, kind, name, vault_label, upi_id, payee_name, priority, weight, min_amount, max_amount,
                            daily_amount, daily_count, monthly_amount, active_from, active_to, active_days, skip_unhealthy,
                            health_min_success, created_by, updated_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::time,$15::time,$16::int[],$17,$18,$19,$19)
    ON CONFLICT DO NOTHING RETURNING id::text
  `, [input.banker, input.kind, name, input.kind === "GATEWAY" ? input.vault_label : null,
      input.kind === "UPI" ? input.upi_id!.trim().toLowerCase() : null, input.payee_name ?? null,
      input.priority ?? existing.length + 1, input.weight ?? 1, input.min_amount ?? null, input.max_amount ?? null,
      input.daily_amount ?? null, input.daily_count ?? null, input.monthly_amount ?? null, input.active_from ?? null,
      input.active_to ?? null, input.active_days ?? null, input.skip_unhealthy ?? true, input.health_min_success ?? null, actor]);
  if (!r[0]) throw new MidSwitchError(409, "it is already in the switch");
  const mid = (await getMid(r[0].id))!;
  await logMidEvent({ banker: input.banker, kind: input.kind, midId: mid.id, action: "ADDED", actor, detail: { name: mid.name } });
  return mid;
}

export async function updateMid(id: string, fields: MidFields, actor: string): Promise<Mid> {
  const cur = await getMid(id);
  if (!cur) throw new MidSwitchError(404, "not found");
  const next = { ...cur, ...fields };
  const bad = validateMidLimits(next);
  if (bad) throw new MidSwitchError(400, bad);
  const sets: string[] = []; const args: unknown[] = [id];
  for (const k of FIELD_COLS) {
    if (!(k in fields)) continue;
    args.push(fields[k] ?? null);
    const cast = k === "active_from" || k === "active_to" ? "::time" : k === "active_days" ? "::int[]" : "";
    sets.push(`${k} = $${args.length}${cast}`);
  }
  if (!sets.length) return cur;
  args.push(actor);
  await rows("vendorGateway", `UPDATE payin_mids SET ${sets.join(", ")}, updated_by = $${args.length}, updated_at = now() WHERE id = $1::uuid`, args);
  const changed = Object.fromEntries(FIELD_COLS.filter((k) => k in fields && JSON.stringify(cur[k as keyof Mid] ?? null) !== JSON.stringify(fields[k] ?? null))
    .map((k) => [k, { from: cur[k as keyof Mid] ?? null, to: fields[k] ?? null }]));
  if (Object.keys(changed).length) await logMidEvent({ banker: cur.banker_code, kind: cur.kind, midId: id, action: "UPDATED", actor, detail: changed });
  return (await getMid(id))!;
}

export async function setMidStatus(id: string, status: "ACTIVE" | "PAUSED" | "DISABLED", reason: string | null, actor: string): Promise<Mid> {
  const cur = await getMid(id);
  if (!cur) throw new MidSwitchError(404, "not found");
  await rows("vendorGateway", `UPDATE payin_mids SET status = $2, status_reason = $3, updated_by = $4, updated_at = now() WHERE id = $1::uuid`,
    [id, status, status === "ACTIVE" ? null : reason, actor]);
  await logMidEvent({ banker: cur.banker_code, kind: cur.kind, midId: id, actor,
    action: status === "ACTIVE" ? "RESUMED" : status, detail: { reason } });
  return (await getMid(id))!;
}

/** Switch on / off, and PRIORITY or WEIGHTED, for one banker and kind. */
export async function saveSettings(banker: string, kind: MidKind, s: { enabled?: boolean; mode?: MidMode }, actor: string): Promise<StoredSettings> {
  await rows("vendorGateway", `
    INSERT INTO payin_mid_settings (banker_code, kind, enabled, mode, updated_by, updated_at)
    VALUES ($1, $2, COALESCE($3, true), COALESCE($4, 'PRIORITY'), $5, now())
    ON CONFLICT (banker_code, kind) DO UPDATE SET
      enabled = COALESCE($3, payin_mid_settings.enabled), mode = COALESCE($4, payin_mid_settings.mode),
      updated_by = $5, updated_at = now()
  `, [banker, kind, s.enabled ?? null, s.mode ?? null, actor]);
  await logMidEvent({ banker, kind, action: "SETTINGS", actor, detail: s });
  return getSettings(banker, kind);
}

/**
 * The manual switch: send this banker's traffic of this kind to one MID (until `minutes` pass,
 * or until switched back), as long as that MID can take each order. null switches back to the
 * automatic rules.
 */
export async function pinMid(banker: string, kind: MidKind, midId: string | null, minutes: number | null, reason: string | null, actor: string): Promise<StoredSettings> {
  if (midId) {
    const m = await getMid(midId);
    if (!m || m.banker_code !== banker || m.kind !== kind) throw new MidSwitchError(404, "no such MID on this account");
  }
  const until = midId && minutes ? new Date(Date.now() + minutes * 60_000).toISOString() : null;
  await rows("vendorGateway", `
    INSERT INTO payin_mid_settings (banker_code, kind, pinned_mid_id, pinned_until, pinned_by, pin_reason, updated_by, updated_at)
    VALUES ($1, $2, $3::uuid, $4::timestamptz, $5, $6, $5, now())
    ON CONFLICT (banker_code, kind) DO UPDATE SET
      pinned_mid_id = $3::uuid, pinned_until = $4::timestamptz, pinned_by = $5, pin_reason = $6, updated_by = $5, updated_at = now()
  `, [banker, kind, midId, until, actor, reason]);
  await logMidEvent({ banker, kind, midId, action: midId ? "PINNED" : "UNPINNED", actor, detail: { until, reason } });
  return getSettings(banker, kind);
}

export interface MidEvent { id: string; kind: string | null; mid_id: string | null; action: string; detail: Record<string, unknown>; actor: string; at: string }

export async function listMidEvents(banker: string, limit = 50): Promise<MidEvent[]> {
  const r = await rows<MidEvent>("vendorGateway", `
    SELECT e.id::text, e.kind, e.mid_id::text, e.action, e.detail, e.actor, e.at
      FROM payin_mid_events e WHERE e.banker_code = $1 ORDER BY e.id DESC LIMIT $2`, [banker, Math.min(Math.max(limit, 1), 200)]);
  return r.map((e) => ({ ...e, at: new Date(e.at).toISOString() }));
}
