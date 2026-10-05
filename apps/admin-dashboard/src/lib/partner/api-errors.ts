// The partner API's error codes. PURE: the API (lib/partner/api), the guide
// (public/katana-partner-guide.html) and a test share this list; the test holds guide and list together.
//
// The pay-in core's refusals are the v2 codes (lib/v2-api-errors), so a partner and a v2 merchant
// read the same code for the same thing; the partner's own come after.

import { V2_ERRORS } from "@/lib/v2-api-errors";

export const PARTNER_API_ERRORS = {
  ...V2_ERRORS,
  ORDER_NOT_FOUND:          { status: 404, meaning: "No order with that id or reference belongs to this partner in this mode." },
  REFERENCE_REUSED:         { status: 409, meaning: "The reference already belongs to an order of another sub-merchant or a different amount." },
  PARTNER_SUSPENDED:        { status: 403, meaning: "The partner account is suspended and takes no orders." },
  SUB_MERCHANT_NOT_FOUND:   { status: 404, meaning: "No sub-merchant with that id or external_id belongs to this partner." },
  SUB_MERCHANT_EXISTS:      { status: 409, meaning: "A sub-merchant with this external_id already exists." },
  SUB_MERCHANT_NOT_ACTIVE:  { status: 403, meaning: "The sub-merchant is not approved for this order: live orders need an ACTIVE sub-merchant; a PENDING one may take test orders." },
  FLOW_NOT_ALLOWED:         { status: 409, meaning: "The requested flow is not one the sub-merchant is on." },
  SUB_MERCHANT_MIN_AMOUNT:  { status: 422, meaning: "The amount is under the sub-merchant's minimum." },
  SUB_MERCHANT_MAX_AMOUNT:  { status: 422, meaning: "The amount is over the sub-merchant's maximum." },
  SUB_MERCHANT_DAILY_LIMIT: { status: 422, meaning: "The order would pass the sub-merchant's limit for the day (India time)." },
  INVALID_STATUS_CHANGE:    { status: 409, meaning: "The sub-merchant's status does not allow that change." },
} as const;

export type PartnerApiErrorCode = keyof typeof PARTNER_API_ERRORS;
