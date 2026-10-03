// The v2 error codes. PURE: no imports, so the API (lib/v2-api), the OpenAPI spec (lib/openapi)
// and the tests share one list. The integration guide prints it; a test holds the two together.

/** Every code a v2 response can carry, with its HTTP status and what it means. The guide prints this list. */
export const V2_ERRORS = {
  HTTPS_REQUIRED:          { status: 400, meaning: "The request was not made over HTTPS." },
  INVALID_REQUEST:         { status: 400, meaning: "A field is missing or malformed; the message names it." },
  UNSUPPORTED_CURRENCY:    { status: 400, meaning: "Only INR is accepted." },
  UNAUTHORIZED:            { status: 401, meaning: "The API key is missing, unknown or revoked." },
  MERCHANT_BLOCKED:        { status: 403, meaning: "The account is blocked and takes no orders." },
  MERCHANT_SUSPENDED:      { status: 403, meaning: "The account is suspended or terminated." },
  PAYIN_NOT_ENABLED:       { status: 403, meaning: "The account is set up for payouts only and takes no pay-in orders." },
  LIVE_MODE_NOT_ACTIVATED: { status: 403, meaning: "A live key was used before live mode was activated." },
  ORDER_NOT_FOUND:         { status: 404, meaning: "No order with that id or reference belongs to this key." },
  REFERENCE_REUSED:        { status: 409, meaning: "The reference already belongs to an order with a different amount." },
  FLOW_NOT_SELECTED:       { status: 409, meaning: "No pay-in flow has been selected for the account yet." },
  FLOW_NOT_ENABLED:        { status: 409, meaning: "The requested flow is not enabled for the account." },
  FLOW_NOT_READY:          { status: 409, meaning: "The account's flow cannot take this payment yet." },
  SETUP_INCOMPLETE:        { status: 409, meaning: "The account has no way to take this payment; contact Katana support." },
  ACCOUNT_NOT_LIVE:        { status: 409, meaning: "Live payments on the account are still being verified." },
  AMOUNT_BELOW_MIN:        { status: 422, meaning: "The amount is under the minimum." },
  AMOUNT_ABOVE_MAX:        { status: 422, meaning: "The amount is over the account's maximum." },
  UPI_LIMIT_EXCEEDED:      { status: 422, meaning: "The amount is over the limit for one UPI payment." },
  DAILY_LIMIT_EXCEEDED:    { status: 422, meaning: "The order would pass the account's limit for the day." },
  RATE_LIMITED:            { status: 429, meaning: "Too many orders in one second; retry after the Retry-After header." },
  PROCESSOR_ERROR:         { status: 502, meaning: "The payment processor did not accept the request; retry with the same reference." },
  INTERNAL_ERROR:          { status: 500, meaning: "Something failed on Katana's side; retry with the same reference." },
} as const;
