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
