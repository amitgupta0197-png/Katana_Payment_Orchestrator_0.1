// Shared display mapping for provider↔branch settlement status.
export function settlementStatusVariant(s: string): "default" | "info" | "warning" | "success" | "danger" | "brand" {
  switch (s) {
    case "VERIFIED": return "success";
    case "UTR_SUBMITTED": return "warning";   // provider action needed
    case "REVIEW": return "warning";
    case "REJECTED": return "danger";
    case "CANCELLED": return "default";
    case "REQUESTED": return "info";          // branch action needed
    default: return "default";
  }
}

export const SETTLEMENT_STATUS_LABEL: Record<string, string> = {
  REQUESTED: "Requested",
  UTR_SUBMITTED: "UTR submitted",
  VERIFIED: "Verified",
  REJECTED: "Rejected",
  REVIEW: "Under review",
  CANCELLED: "Cancelled",
};
