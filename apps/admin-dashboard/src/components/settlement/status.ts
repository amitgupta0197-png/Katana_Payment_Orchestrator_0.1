// Shared display mapping for the Upline↔Downline settlement status lifecycle.
export function settlementStatusVariant(s: string): "default" | "info" | "warning" | "success" | "danger" | "brand" {
  switch (s) {
    case "VERIFIED":
    case "PAID":
    case "USDT_TRANSFERRED":
    case "RECONCILED": return "success";
    case "UTR_SUBMITTED":
    case "PARTIALLY_PAID":
    case "ON_HOLD":
    case "REVIEW":
    case "COMPLIANCE_REVIEW":
    case "CORRECTION_REQUIRED":
    case "ESCALATED": return "warning";
    case "REJECTED":
    case "FAILED":
    case "REVERSED":
    case "INSUFFICIENT_BALANCE":
    case "INVALID_BENEFICIARY": return "danger";
    case "ACCEPTED":
    case "PROCESSING": return "brand";
    case "REQUESTED": return "info";          // branch action needed
    case "CANCELLED":
    case "DRAFT": return "default";
    default: return "default";
  }
}

export const SETTLEMENT_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  REQUESTED: "Requested",
  ACCEPTED: "Accepted",
  PROCESSING: "Processing",
  PAID: "Paid",
  PARTIALLY_PAID: "Partially paid",
  UTR_SUBMITTED: "UTR submitted",
  USDT_TRANSFERRED: "USDT transferred",
  VERIFIED: "Confirmed",
  RECONCILED: "Reconciled",
  REJECTED: "Rejected",
  ON_HOLD: "On hold",
  FAILED: "Failed",
  REVERSED: "Reversed",
  CORRECTION_REQUIRED: "Correction required",
  ESCALATED: "Escalated to Katana",
  COMPLIANCE_REVIEW: "Compliance review",
  INSUFFICIENT_BALANCE: "Insufficient balance",
  INVALID_BENEFICIARY: "Invalid beneficiary",
  REVIEW: "Under review",
  CANCELLED: "Cancelled",
};

export function settlementStatusLabel(s: string): string {
  return SETTLEMENT_STATUS_LABEL[s] ?? s;
}
