import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

export function formatAmount(value: number | string | null | undefined, currency = "INR"): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = typeof value === "string" ? Number(value) : value;
  if (Number.isNaN(n)) return "—";
  return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 2 }).format(n);
}

export type StatusVariant = "default" | "success" | "warning" | "danger" | "info" | "brand";

const STATUS_MAP: Record<string, StatusVariant> = {
  ACTIVE: "success", LIVE: "success", APPROVED: "success", SUCCEEDED: "success", SETTLED: "success",
  COMPLETED: "success", RELEASED: "success", MATCHED: "success", WON: "success", CAPTURED: "success",

  PENDING: "warning", IN_REVIEW: "warning", DOCS_PENDING: "warning", PROCESSING: "warning",
  INITIATED: "warning", HELD: "warning", PARTIAL_RELEASE: "warning", DISPUTED: "warning",
  REFUND_INITIATED: "warning",

  REJECTED: "danger", FAILED: "danger", DECLINED: "danger", CANCELLED: "danger", SUSPENDED: "danger",
  TERMINATED: "danger", BOUNCED_BACK: "danger", BREAK: "danger", LOST: "danger", FORFEITED: "danger",
  CHARGEBACK: "danger", EXPIRED: "danger",

  NEW: "info", REQUESTED: "info", REVIEW: "info", REFUNDED: "info", UNMATCHED: "info",
  TRAFFIC: "info", KYC_APPROVED: "brand",
};

export function statusVariant(status: string | null | undefined): StatusVariant {
  if (!status) return "default";
  return STATUS_MAP[status.toUpperCase()] ?? "default";
}

// Display label for a payment rail / vendor code. The stored vendor identifier
// stays "POOLPAY" (DB value + API contract), but the product is branded "Katana
// Pay" in the UI — so map it here at render time. Unknown codes pass through.
const RAIL_LABELS: Record<string, string> = {
  POOLPAY: "Katana Pay",
  POOLPAY_PO: "Katana Pay Payout",
};

export function railLabel(code: string | null | undefined): string {
  if (!code) return "—";
  return RAIL_LABELS[code.toUpperCase()] ?? code;
}

// ── Display names for stored enum values ─────────────────────────────────────
// The DB stores PROVIDER / MERCHANT as persona and provider.kind values. The product
// calls those a Merchant and a Banker respectively. Mapping happens at render time
// only — the stored values are what scope.ts and every gate key off, so renaming them
// in the database would be an access-control change, not a wording one.
const ENTITY_DISPLAY: Record<string, string> = {
  PROVIDER: "MERCHANT",
  MERCHANT: "BANKER",
};

/** Render a stored persona / kind value using product terminology. */
export function displayEntity(value: string | null | undefined): string {
  if (!value) return "—";
  return ENTITY_DISPLAY[value] ?? value;
}
