// Direct-Postgres read helper for the BFF.
//
// For services that don't yet expose a paginated list via gRPC, the
// dashboard reads straight from their database. Pools are memoized
// per-database so we re-use connections.

import { Pool, type QueryResultRow } from "pg";

const PG_HOST = process.env.PG_HOST ?? "localhost";
const PG_PORT = Number(process.env.PG_PORT ?? 5432);
const PG_USER = process.env.PG_USER ?? "sixsenai";
const PG_PASSWORD = process.env.PG_PASSWORD ?? "sixsenai_pg_2024_secure";

const pools = new Map<string, Pool>();

export type DbKey =
  | "ledger"
  | "reconciliation"
  | "settlement"
  | "payout"
  | "collections"
  | "agentFranchise"
  | "commission"
  | "riskVelocity"
  | "reporting"
  | "kybPayments"
  | "tenant"
  | "audit"
  | "notification"
  | "webhook"
  | "config"
  | "routingEngine"
  | "bankAdapter"
  | "cryptoRail"
  | "checkout"
  | "pgAdapter"
  | "auth"
  | "iam"
  | "merchant"
  | "vendorGateway"
  | "provider"
  | "mid"
  | "fifo";

const DB_NAMES: Record<DbKey, string> = {
  ledger: "ledgerservice_db",
  reconciliation: "reconciliationservice_db",
  settlement: "settlementservice_db",
  payout: "payoutservice_db",
  collections: "collectionsservice_db",
  agentFranchise: "agentfranchiseservice_db",
  commission: "commissionservice_db",
  riskVelocity: "riskvelocityservice_db",
  reporting: "reportingservice_db",
  kybPayments: "kybpaymentsservice_db",
  tenant: "tenantservice_db",
  audit: "auditservice_db",
  notification: "notificationservice_db",
  webhook: "webhookservice_db",
  config: "configservice_db",
  routingEngine: "routingengineservice_db",
  bankAdapter: "bankadapterservice_db",
  cryptoRail: "cryptorailservice_db",
  checkout: "checkoutservice_db",
  pgAdapter: "pgadapterservice_db",
  auth: "authservice_db",
  iam: "iamservice_db",
  merchant: "merchantservice_db",
  vendorGateway: "vendorgatewayservice_db",
  provider: "providerservice_db",
  mid: "midservice_db",
  fifo: "fifoservice_db",
};

export function db(key: DbKey): Pool {
  const hit = pools.get(key);
  if (hit) return hit;
  const pool = new Pool({
    host: PG_HOST,
    port: PG_PORT,
    user: PG_USER,
    password: PG_PASSWORD,
    database: DB_NAMES[key],
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  pools.set(key, pool);
  return pool;
}

export async function rows<T extends QueryResultRow = Record<string, unknown>>(
  key: DbKey,
  sql: string,
  args: unknown[] = []
): Promise<T[]> {
  const res = await db(key).query<T>(sql, args as any);
  return res.rows;
}

export function pgError(err: unknown): { status: number; body: { error: string } } {
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : "DB error";
  if (/relation .* does not exist/.test(message)) {
    return { status: 503, body: { error: "Service not initialized: " + message } };
  }
  return { status: 500, body: { error: message } };
}
