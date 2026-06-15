#!/usr/bin/env bash
# Bootstrap the Postgres tier for the reconstructed dashboard.
#
# Runs everything via `docker exec` against the katana-postgres container
# brought up by tools/docker-compose.yml — no local psql needed.
#
# Usage:
#   docker compose -f tools/docker-compose.yml up -d
#   bash tools/bootstrap-db.sh
#
# Idempotent: re-runs are safe.

set -euo pipefail

CONTAINER="${CONTAINER:-katana-postgres}"
PGUSER="${PG_USER:-sixsenai}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$ROOT/tools/migrations"
SEED="$ROOT/tools/seed"

# All databases the BFF connects to (per apps/admin-dashboard/src/lib/pg.ts).
DATABASES=(
  ledgerservice_db reconciliationservice_db settlementservice_db payoutservice_db
  collectionsservice_db agentfranchiseservice_db commissionservice_db
  riskvelocityservice_db reportingservice_db kybpaymentsservice_db tenantservice_db
  auditservice_db notificationservice_db webhookservice_db configservice_db
  routingengineservice_db bankadapterservice_db cryptorailservice_db checkoutservice_db
  pgadapterservice_db authservice_db iamservice_db merchantservice_db
  vendorgatewayservice_db providerservice_db midservice_db
)

if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  echo "[bootstrap] container '$CONTAINER' is not running. Run:"
  echo "  docker compose -f tools/docker-compose.yml up -d"
  exit 1
fi

echo "[bootstrap] waiting for Postgres to accept connections…"
for i in $(seq 1 30); do
  if docker exec "$CONTAINER" pg_isready -U "$PGUSER" -q; then break; fi
  sleep 1
done

# Run a SQL string against a database inside the container.
exec_sql() {
  docker exec -i "$CONTAINER" psql -U "$PGUSER" -d "$1" -v ON_ERROR_STOP=1 -q -c "$2"
}
# Run a SQL file (piped via stdin so we don't need to bind-mount).
exec_file() {
  docker exec -i "$CONTAINER" psql -U "$PGUSER" -d "$1" -v ON_ERROR_STOP=1 -q < "$2"
}
exists_db() {
  docker exec "$CONTAINER" psql -U "$PGUSER" -d postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname='$1'" | tr -d '[:space:]'
}

echo "[bootstrap] ensuring databases exist…"
for db in "${DATABASES[@]}"; do
  if [[ "$(exists_db "$db")" != "1" ]]; then
    echo "  creating $db"
    docker exec "$CONTAINER" psql -U "$PGUSER" -d postgres -q -c "CREATE DATABASE \"$db\""
  fi
done

echo "[bootstrap] applying migrations…"
for svc in auth iam provider merchant mid; do
  case "$svc" in
    auth)     db=authservice_db ;;
    iam)      db=iamservice_db ;;
    provider) db=providerservice_db ;;
    merchant) db=merchantservice_db ;;
    mid)      db=midservice_db ;;
  esac
  for f in "$MIG/$svc"/*.sql; do
    echo "  $svc ← $(basename "$f")"
    exec_file "$db" "$f"
  done
done

echo "[bootstrap] applying seed data…"
exec_file providerservice_db "$SEED/01_provider_merchant.sql"
exec_file merchantservice_db "$SEED/02_merchant.sql"
exec_file providerservice_db "$SEED/03_provider_mapping.sql"
exec_file midservice_db      "$SEED/04_mid.sql"
exec_file authservice_db     "$SEED/05_users.sql"
exec_file iamservice_db      "$SEED/06_personas.sql"

echo "[bootstrap] done. login at http://localhost:3100/login with password 'demo':"
echo "  admin@katana.dev    → SUPER_ADMIN  → /"
echo "  provider@katana.dev → PROVIDER     → /provider-portal"
echo "  merchant@katana.dev → MERCHANT     → /merchant-portal"
