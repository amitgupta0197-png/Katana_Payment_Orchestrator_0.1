// The API request log (audit 0007): one row for each request a merchant's server made to the
// order APIs.
//
// A merchant reads a summary of its own rows (time, endpoint, status, latency) for the last
// 7 days and never a body. Staff read the bodies too, for any merchant and any date range.
//
// WHAT IS STORED IS ALREADY REDACTED. The Authorization header is never kept, and a credential
// in a body (`hash`, `key`, `salt`, `secret`, anything named like one) is cut to a hint before
// the row is written, so a staff export cannot leak one either.
//
// Best-effort, after the answer is decided: a row that cannot be written never changes what the
// merchant is told.

import { rows } from "@/lib/pg";

export interface ApiLogEntry {
  requestId: string;
  merchantId: string | null;
  livemode: boolean | null;
  apiVersion: "v1" | "v2";
  method: string;
  /** The route, not the full URL: /v2/orders, /v2/orders/{id}. */
  endpoint: string;
  httpStatus: number;
  latencyMs: number;
  errorCode?: string | null;
  requestBody?: unknown;
  responseBody?: unknown;
  ip?: string | null;
}

const SECRET_KEY = /^(hash|key|salt|secret|password|token|authorization|api_key|webhook_secret)$/i;
const MAX_BODY = 8_000;

/** A body with its credentials cut to a hint, and bounded. Pure. */
export function redactBody(body: unknown, depth = 0): unknown {
  if (body == null || depth > 4) return body ?? null;
  if (Array.isArray(body)) return body.slice(0, 50).map((v) => redactBody(v, depth + 1));
  if (typeof body === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (SECRET_KEY.test(k)) out[k] = typeof v === "string" && v.length > 8 ? `${v.slice(0, 4)}…(${v.length})` : "…";
      else out[k] = redactBody(v, depth + 1);
    }
    return out;
  }
  return typeof body === "string" && body.length > 2_000 ? `${body.slice(0, 2_000)}…` : body;
}

function bounded(body: unknown): string | null {
  if (body === undefined || body === null) return null;
  const s = JSON.stringify(redactBody(body));
  return s.length > MAX_BODY ? JSON.stringify({ truncated: true, bytes: s.length }) : s;
}

/** Record a request. Never throws, and is not awaited by the route. */
export function logApiRequest(e: ApiLogEntry): void {
  void rows("audit", `
    INSERT INTO api_request_log
      (request_id, merchant_id, livemode, api_version, method, endpoint, http_status, latency_ms,
       error_code, request_body, response_body, ip)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12)
  `, [e.requestId, e.merchantId, e.livemode, e.apiVersion, e.method, e.endpoint, e.httpStatus,
      Math.max(0, Math.round(e.latencyMs)), e.errorCode ?? null, bounded(e.requestBody), bounded(e.responseBody), e.ip ?? null])
    .catch((err) => console.warn("[api-log] not recorded:", (err as Error).message));
}

export interface ApiLogRow {
  id: string; request_id: string; merchant_id: string | null; livemode: boolean | null; api_version: string;
  method: string; endpoint: string; http_status: number; latency_ms: number; error_code: string | null;
  created_at: string;
  request_body?: unknown; response_body?: unknown; ip?: string | null;
}

export const MERCHANT_LOG_DAYS = 7;

export interface ApiLogQuery {
  /** The bankers whose rows may be read; null = every merchant (staff). */
  merchantCodes: string[] | null;
  /** Staff only: with bodies, any range, one merchant. */
  full?: boolean;
  merchant?: string | null;
  from?: string | null;      // YYYY-MM-DD, India day
  to?: string | null;
  status?: "ok" | "error" | null;
  limit?: number;
}

/** Rows newest first. Without `full` only the summary columns of the last 7 days are read. */
export async function readApiLog(q: ApiLogQuery): Promise<ApiLogRow[]> {
  const where: string[] = [], args: unknown[] = [];
  const add = (sql: string, v: unknown) => { args.push(v); where.push(sql.replace("?", `$${args.length}`)); };
  if (q.merchantCodes) add("merchant_id = ANY(?::text[])", q.merchantCodes);
  if (q.merchant) add("merchant_id = ?", q.merchant);
  if (q.full) {
    if (q.from) add("created_at >= (?::date::timestamp AT TIME ZONE 'Asia/Kolkata')", q.from);
    if (q.to) add("created_at < ((?::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')", q.to);
    if (!q.from && !q.to) where.push(`created_at > now() - interval '${MERCHANT_LOG_DAYS} days'`);
  } else where.push(`created_at > now() - interval '${MERCHANT_LOG_DAYS} days'`);
  if (q.status === "ok") where.push("http_status < 400");
  if (q.status === "error") where.push("http_status >= 400");
  const limit = Math.min(Math.max(q.limit ?? 200, 1), q.full ? 5_000 : 500);
  return rows<ApiLogRow>("audit", `
    SELECT id::text, request_id, merchant_id, livemode, api_version, method, endpoint, http_status, latency_ms,
           error_code, created_at${q.full ? ", request_body, response_body, ip" : ""}
      FROM api_request_log l
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY l.created_at DESC, l.id DESC LIMIT ${limit}
  `, args);
}

/** Remove rows older than `days`. Called by the daily job. */
export async function pruneApiLog(days = 90): Promise<number> {
  const r = await rows("audit", `DELETE FROM api_request_log WHERE created_at < now() - make_interval(days => $1::int) RETURNING 1`, [days]);
  return r.length;
}
