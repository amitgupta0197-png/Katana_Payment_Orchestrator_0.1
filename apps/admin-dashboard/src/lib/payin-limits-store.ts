// A banker's pay-in limits and its usage, read and written. The rules are in lib/payin-limits.

import { db, rows } from "@/lib/pg";
import { NO_LIMITS, PayinLimitError, dailyBreach, validatePayinLimits, type PayinLimits, type PayinUsage } from "@/lib/payin-limits";

export interface StoredPayinLimits extends PayinLimits {
  setBy: string | null;
  setAt: string | null;
}

const num = (v: string | number | null | undefined) => (v == null ? null : Number(v));

/** A banker's own limits. None set, or a database without the columns yet, is "no limits of its own". */
export async function getPayinLimits(merchantCode: string | null | undefined): Promise<StoredPayinLimits> {
  if (!merchantCode) return { ...NO_LIMITS, setBy: null, setAt: null };
  const r = await rows<{ min: string | null; max: string | null; daily: string | null; tps: number | null; by: string | null; at: string | null }>("merchant", `
    SELECT payin_min_amount::text AS min, payin_max_amount::text AS max, payin_daily_amount::text AS daily,
           payin_max_tps AS tps, payin_limits_set_by AS by, payin_limits_set_at AS at
      FROM merchant_payment_config WHERE merchant_code = $1
  `, [merchantCode]).catch(() => []);
  const l = r[0];
  if (!l) return { ...NO_LIMITS, setBy: null, setAt: null };
  return { min: num(l.min), max: num(l.max), daily: num(l.daily), maxTps: l.tps, setBy: l.by, setAt: l.at };
}

/** Save a banker's limits (null clears one). */
export async function setPayinLimits(merchantCode: string, l: PayinLimits, by: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const bad = validatePayinLimits(l);
  if (bad) return { ok: false, error: bad };
  await rows("merchant", `
    INSERT INTO merchant_payment_config
      (merchant_code, payin_min_amount, payin_max_amount, payin_daily_amount, payin_max_tps,
       payin_limits_set_by, payin_limits_set_at, updated_by, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, now(), $6, now())
    ON CONFLICT (merchant_code) DO UPDATE SET
      payin_min_amount = EXCLUDED.payin_min_amount, payin_max_amount = EXCLUDED.payin_max_amount,
      payin_daily_amount = EXCLUDED.payin_daily_amount, payin_max_tps = EXCLUDED.payin_max_tps,
      payin_limits_set_by = EXCLUDED.payin_limits_set_by, payin_limits_set_at = now(),
      updated_by = EXCLUDED.updated_by, updated_at = now()
  `, [merchantCode, l.min, l.max, l.daily, l.maxTps, by]);
  return { ok: true };
}

const DAY_AMOUNT_SQL = `
  SELECT COALESCE(SUM(amount), 0)::text AS day_amount
    FROM vendor_payin_orders
   WHERE vendor = 'KATANA' AND merchant_id = $1 AND livemode AND status NOT IN ('FAILED','EXPIRED')
     AND created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`;

/**
 * Insert a live order only if the banker's day still has room for it.
 *
 * The check made before a gateway is asked (getPayinUsage) reads the day's total without a
 * lock, so two orders created at the same instant can each see the day before the other. This
 * is the check that holds: one transaction takes a lock for the banker's day, reads the total
 * again and inserts. Orders of the same banker queue behind each other for that moment;
 * different bankers never wait on each other. The lock is not held while a gateway is called.
 *
 * Throws PayinLimitError (DAILY_LIMIT_EXCEEDED) when the order no longer fits.
 */
export async function insertWithinDailyLimit<T>(merchantCode: string, amount: number, daily: number, sql: string, args: unknown[]): Promise<T[]> {
  const client = await db("vendorGateway").connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`payin-day:${merchantCode}`]);
    const used = Number((await client.query<{ day_amount: string }>(DAY_AMOUNT_SQL, [merchantCode])).rows[0]?.day_amount ?? 0);
    const breach = dailyBreach(amount, used, daily);
    if (breach) throw new PayinLimitError(breach);
    const r = await client.query(sql, args as any[]);
    await client.query("COMMIT");
    return r.rows as T[];
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * What a banker has used: today's live order total and the orders of the last second.
 *
 * "Today" is the day in India. Failed and expired orders are not counted, so an abandoned order
 * gives its amount back when it expires; pending ones are, so a burst cannot pass the limit
 * before any of it is paid. The rate counts orders of the mode asked about.
 *
 * The total is read, not locked. It refuses an order early, before a gateway is asked;
 * insertWithinDailyLimit is what holds the limit when orders arrive together.
 */
export async function getPayinUsage(merchantCode: string, livemode: boolean): Promise<PayinUsage> {
  const r = await rows<{ day_amount: string; last_second: number }>("vendorGateway", `
    SELECT COALESCE(SUM(amount) FILTER (WHERE livemode AND status NOT IN ('FAILED','EXPIRED')), 0)::text AS day_amount,
           COUNT(*) FILTER (WHERE livemode = $2 AND created_at > now() - interval '1 second')::int AS last_second
      FROM vendor_payin_orders
     WHERE vendor = 'KATANA' AND merchant_id = $1
       AND created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')
  `, [merchantCode, livemode]);
  return { dayAmount: Number(r[0]?.day_amount ?? 0), lastSecond: r[0]?.last_second ?? 0 };
}
