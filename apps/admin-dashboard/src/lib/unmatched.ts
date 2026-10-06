// "Unmatched payments": money a banker's phone captured that no order took, and the orders it could
// be for. PURE. lib/unmatched-store reads the payments and candidate orders (lib/credit-link for which
// orders qualify) and records what a person decides (vendorGateway 0045).
//
// Who may do what:
//   staff (LINK_ROLES)        link a payment to an order at once (lib/credit-link-store), approve or
//                             reject a request, mark "not an order payment", undo a mark
//   merchant / banker login   only its own bankers' payments: ask for a link (waits for staff) or
//                             mark "not an order payment"
// Shown to merchants: no gateway is named and the payer's UPI ID is masked.

export const LINK_ROLES = ["SUPER_ADMIN", "ADMIN", "OPERATOR", "FINANCE"] as const;
export const isLinkRole = (persona: string) => (LINK_ROLES as readonly string[]).includes(persona);

/** "ab12…@okaxis" → "ab***@okaxis"; null stays null. */
export function maskVpa(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  const at = s.indexOf("@");
  if (at <= 0) return s.length <= 2 ? "**" : `${s.slice(0, 2)}***`;
  return `${s.slice(0, Math.min(2, at))}***${s.slice(at)}`;
}

export type ReviewDecision = "LINK" | "NOT_ORDER";
export type ReviewStatus = "PENDING" | "DONE" | "REJECTED";
export interface Review { decision: ReviewDecision; status: ReviewStatus; order_id: string | null; order_ref: string | null; requested_by: string; requested_as: string; note: string | null }

export type UnmatchedAction = "link" | "not_order" | "approve" | "reject" | "undo";

/**
 * Whether this login may take this action on a payment with this review. Returns null when allowed,
 * else the plain-words reason.
 */
export function actionRefusal(action: UnmatchedAction, staff: boolean, review: Review | null): string | null {
  if (review?.status === "DONE" && review.decision === "LINK") return "This payment is already linked to an order.";
  switch (action) {
    case "link":
      if (review?.status === "PENDING") return "A link for this payment is already waiting for Katana.";
      if (review?.decision === "NOT_ORDER" && review.status === "DONE") return "This payment is marked as not an order payment. Undo that first.";
      return null;
    case "not_order":
      if (review?.status === "PENDING") return "A link for this payment is waiting for Katana.";
      if (review?.decision === "NOT_ORDER") return "This payment is already marked as not an order payment.";
      return null;
    case "approve": case "reject":
      if (!staff) return "Only Katana staff approve a link.";
      return review?.status === "PENDING" && review.decision === "LINK" ? null : "There is no link waiting for approval.";
    case "undo":
      if (!staff) return "Only Katana staff can undo this.";
      return review?.decision === "NOT_ORDER" && review.status === "DONE" ? null : "There is nothing to undo.";
  }
}

/** Plain words for the state of a payment in the queue. */
export function reviewLabel(r: Review | null): string {
  if (!r) return "Needs an order";
  if (r.decision === "NOT_ORDER") return r.status === "DONE" ? "Not an order payment" : "Needs an order";
  if (r.status === "PENDING") return `Waiting for Katana: link to ${r.order_ref ?? "an order"}`;
  if (r.status === "REJECTED") return "Link refused by Katana";
  return `Linked to ${r.order_ref ?? "an order"}`;
}
