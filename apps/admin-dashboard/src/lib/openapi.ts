// OpenAPI 3.0 spec for the public Katana Pay integration API. Single source of
// truth — served as JSON at /api/openapi and rendered as Swagger UI at /developers.

import { V2_ERRORS } from "@/lib/v2-api-errors";

// A v2 error answer for one HTTP status, listing the codes that status can carry.
function v2Error(status: number) {
  const codes = Object.entries(V2_ERRORS).filter(([, e]) => e.status === status).map(([c]) => `\`${c}\``).join(", ");
  return { description: codes, content: { "application/json": { schema: { $ref: "#/components/schemas/V2Error" } } } };
}
const V2_SECURITY = [{ ApiKey: [] }];

// The P2P and Intent order APIs: the general order operation, for one flow by name.
function flowOrderOp(flow: string, how: string) {
  return {
    tags: ["Pay-in"],
    summary: `Create a ${flow} pay-in order`,
    description: `Same request, signature and response as \`POST /api/v1/katana-pay/order\`; the order always takes the ${flow} flow (${how}). Refused with \`409\` and a \`code\` (\`FLOW_NOT_ENABLED\`, \`FLOW_NOT_SELECTED\`, \`FLOW_NOT_READY\`) when the account is not set up for it.`,
    requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CreateOrderRequest" } } } },
    responses: {
      "201": { description: "Order created", content: { "application/json": { schema: { $ref: "#/components/schemas/CreateOrderResponse" } } } },
      "200": { description: "The same `txnid` was sent again: the existing order" },
      "401": { description: "Invalid key or signature mismatch" },
      "409": { description: "The account is not set up for this flow" },
    },
  };
}

export const openapiSpec = {
  openapi: "3.0.3",
  info: {
    title: "Katana Pay API",
    version: "1.0.0",
    description: [
      "Server-to-server (S2S) UPI pay-in and payout API for integrating Katana Pay into your platform.",
      "",
      "## Authentication",
      "Each request is authenticated per-merchant with a **Checkout Key + Salt** pair",
      "(issued in the Katana dashboard). You send the public **Key** and a **signature**",
      "(`hash`) of the order fields; the **Salt** stays on your server and is never sent.",
      "",
      "**Signature** — every new Key + Salt uses `HMAC_SHA256`; pairs issued earlier with the legacy SHA-512 scheme keep working until regenerated:",
      "- `HMAC_SHA256`: `HMAC_SHA256(key + salt, \"txnid|amount|productinfo|email\")` (hex)",
      "- Legacy SHA-512 (older pairs only): `sha512(\"key|txnid|amount|productinfo|firstname|email|||||||||||salt\")` (hex)",
      "",
      "## Pay-in flows",
      "An account is set up for **P2P**, **Intent** or **Both**. `POST /api/v1/p2p/order` and `POST /api/v1/intent/order`",
      "take the same request and return the same response as `POST /api/v1/katana-pay/order`, for that flow by name;",
      "the general API uses the flow selected for the account. A flow the account is not set up for is refused with",
      "`409` and `code` `FLOW_NOT_ENABLED`, `FLOW_NOT_SELECTED` or `FLOW_NOT_READY`. Status per flow:",
      "`GET /api/v1/p2p/order/{id}` and `GET /api/v1/intent/order/{id}` (`id` or the `P2P-…` / `INT-…` reference).",
      "",
      "## Flow",
      "1. `POST /api/v1/katana-pay/order` with the signed order → get QR / deeplinks / `pay_url`.",
      "2. Show the customer the QR or redirect them to `pay_url`. A merchant paid on a gateway's own page",
      "   gets no QR or deeplinks — send the customer to `pay_url` or `gateway_url`.",
      "3. Receive the result via **webhook** (configured in the dashboard) or by polling",
      "   `GET /api/pay-status/{id}` until `terminal: true`.",
      "",
      "## Test mode",
      "Each merchant has a test pair (`mk_test_…`) and a live pair (`mk_live_…`); the Key that signs the order",
      "decides its mode. Test orders pay a sandbox UPI ID and never move real money. For test orders only, the",
      "amount's last two paise digits force outcomes: `.99` → success (~8s), `.11` → expired, `.13` → failed;",
      "anything else stays PENDING. A test order's hosted pay page also has Simulate success / failure buttons.",
      "",
      "## Payouts",
      "Payout requests use the same Key + Salt with a payout-specific signed string (same scheme as above,",
      "different fields, joined with `|`):",
      "- Legacy SHA-512: `sha512(\"key|f1|f2|…|salt\")` · `HMAC_SHA256`: `HMAC_SHA256(key + salt, \"f1|f2|…\")`",
      "- register beneficiary: `beneficiary_ref|name|account_number|ifsc|upi_id`",
      "- create payout: `txnid|amount|beneficiary|rail|purpose` (`beneficiary` = the `beneficiary_ref` or `beneficiary_id` you send)",
      "- payout status: `txnid` (or `payout_id`)",
      "A field you leave out is signed as an empty string in its position. `amount` is signed exactly as sent.",
      "",
      "1. Register the beneficiary once. It starts `PENDING`; Katana approves it before it can be paid.",
      "2. `POST /api/v1/payouts/create` — idempotent on `txnid`. **A timeout is not a failure**: retry with the same",
      "   `txnid` or ask `/api/v1/payouts/status`. A new `txnid` is a second payout.",
      "3. Receive the signed `payout.status` callback, or poll status until `terminal: true`. A `SUCCESS` payout can",
      "   still become `REVERSED` if the beneficiary's bank returns it.",
      "A test Key pays out through the payout provider's sandbox only and never moves real money.",
      "",
      "## API v2",
      "`POST /v2/orders` and `GET /v2/orders/{id}` are a simpler way to do the same thing. A v2 request carries an API key",
      "in the `Authorization: Bearer` header (`sk_test_…` or `sk_live_…`, made in the dashboard under Webhooks & keys) and",
      "no signature. Amounts are integers in paise. A status is one of `PENDING`, `SUCCESS`, `FAILED`, `EXPIRED`. Every",
      "error is `{ code, message, reference }`. The webhook is `payment.success` / `payment.failed` / `payment.expired`,",
      "signed in the `X-Katana-Signature` header, and its body is the same object `GET /v2/orders/{id}` returns.",
      "**Webhooks are notifications; they can fail or retry. Always confirm order status by calling GET /v2/orders/{id} before fulfilling.**",
      "Full guide: `/katana-v2-guide.html`. Everything below marked v1 keeps working unchanged.",
      "",
      "## Going live",
      "A live Key is refused with `403` and `code: LIVE_MODE_NOT_ACTIVATED` until live mode is activated for the",
      "merchant (dashboard: Integration → Activate live mode, approved by Katana).",
    ].join("\n"),
  },
  servers: [{ url: "https://katanapay.co", description: "Production" }],
  tags: [
    { name: "v2", description: "The v2 order API: Bearer API key, paise, four statuses" },
    { name: "Pay-in", description: "Create and track S2S UPI pay-in orders" },
    { name: "Payout", description: "Register beneficiaries and send payouts (IMPS / NEFT / RTGS / UPI)" },
  ],
  paths: {
    "/v2/orders": {
      post: {
        tags: ["v2"], security: V2_SECURITY,
        summary: "Create an order",
        description: "Creates an order and returns the page to send the customer to. Idempotent on `reference`: sending the same reference again returns the same order (`200`); the same reference with a different amount is refused (`409 REFERENCE_REUSED`).",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/V2CreateOrder" } } } },
        responses: {
          "201": { description: "Order created", content: { "application/json": { schema: { $ref: "#/components/schemas/V2OrderCreated" } } } },
          "200": { description: "The reference was used before: the existing order", content: { "application/json": { schema: { $ref: "#/components/schemas/V2OrderCreated" } } } },
          "400": v2Error(400), "401": v2Error(401), "403": v2Error(403), "409": v2Error(409), "422": v2Error(422), "429": v2Error(429), "500": v2Error(500), "502": v2Error(502),
        },
      },
    },
    "/v2/orders/{id}": {
      get: {
        tags: ["v2"], security: V2_SECURITY,
        summary: "Read an order",
        description: "By Katana's `order_id` (`KTN_…`) or by your own `reference`. A key reads only the orders of its own account and mode. The answer is the object a webhook carries, plus `checkout_url`, `expires_at`, `created_at`, `livemode` and `metadata`.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" }, description: "`order_id` or your `reference`" }],
        responses: {
          "200": { description: "The order", content: { "application/json": { schema: { $ref: "#/components/schemas/V2Order" } } } },
          "401": v2Error(401), "404": v2Error(404),
        },
      },
    },
    "/api/v1/katana-pay/order": {
      post: {
        tags: ["Pay-in"],
        summary: "Create a pay-in (S2S) order",
        description: "Creates a UPI collect order and returns QR payload, app deeplinks, and a hosted pay URL. Idempotent on `txnid` — re-sending the same `txnid` returns the same order.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CreateOrderRequest" },
              examples: {
                qr: {
                  summary: "QR order with customer name + mobile",
                  value: {
                    key: "mk_test_xxx",
                    txnid: "ORDER-1001",
                    amount: "499.00",
                    hash: "<hex signature>",
                    productinfo: "Order 1001",
                    firstname: "Asha Kumar",
                    email: "buyer@example.com",
                    phone: "9999999999",
                    mode: "QR",
                  },
                },
              },
            },
            "application/x-www-form-urlencoded": {
              schema: { $ref: "#/components/schemas/CreateOrderRequest" },
            },
          },
        },
        responses: {
          "201": { description: "Order created", content: { "application/json": { schema: { $ref: "#/components/schemas/CreateOrderResponse" } } } },
          "200": { description: "Existing order returned (same txnid)", content: { "application/json": { schema: { $ref: "#/components/schemas/CreateOrderResponse" } } } },
          "400": { description: "Invalid request / amount", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "401": { description: "invalid key or signature mismatch", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "403": { description: "The account is blocked or suspended (`code: MERCHANT_BLOCKED` / `MERCHANT_SUSPENDED`), or a live Key was used before live mode is activated (`code: LIVE_MODE_NOT_ACTIVATED`)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "409": { description: "The merchant can't take live payments yet: no pay-in gateway and no receiving UPI ID", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "The order is outside the account's limits; no order was created. `code` is `AMOUNT_BELOW_MIN`, `AMOUNT_ABOVE_MAX`, `UPI_LIMIT_EXCEEDED` or `DAILY_LIMIT_EXCEEDED`. A repeated `txnid` is never limited.", content: { "application/json": { schema: { $ref: "#/components/schemas/LimitError" } } } },
          "429": { description: "Too many orders in one second (`code: RATE_LIMITED`). Retry after the `Retry-After` header.", content: { "application/json": { schema: { $ref: "#/components/schemas/LimitError" } } } },
          "502": { description: "The gateway refused the order (e.g. below its minimum amount); no order was created", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/api/v1/p2p/order": { post: flowOrderOp("P2P", "a UPI link or QR that pays the receiving UPI ID directly, confirmed by the bank credit") },
    "/api/v1/intent/order": { post: flowOrderOp("Intent", "issued and confirmed by the payment gateway") },
    "/api/pay-status/{id}": {
      get: {
        tags: ["Pay-in"],
        summary: "Get order status",
        description: "Public status lookup — the order `id` (UUID) in the URL is the capability. Poll until `terminal` is true.",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" }, description: "The `order.id` (UUID) from the create response." },
        ],
        responses: {
          "200": { description: "Order status", content: { "application/json": { schema: { $ref: "#/components/schemas/PayStatus" } } } },
          "404": { description: "Order not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/api/v1/payouts/beneficiaries": {
      post: {
        tags: ["Payout"],
        summary: "Register a payout beneficiary",
        description: "Creates the beneficiary `PENDING`; it can be paid once Katana approves it. Re-sending the same `beneficiary_ref` with the same details returns it with its current status (`reused: true`); different details are refused with `409`. Signed string: `beneficiary_ref|name|account_number|ifsc|upi_id`.",
        requestBody: { required: true, content: {
          "application/json": { schema: { $ref: "#/components/schemas/RegisterBeneficiaryRequest" } },
          "application/x-www-form-urlencoded": { schema: { $ref: "#/components/schemas/RegisterBeneficiaryRequest" } },
        } },
        responses: {
          "201": { description: "Registered (PENDING)", content: { "application/json": { schema: { $ref: "#/components/schemas/BeneficiaryResponse" } } } },
          "200": { description: "Already registered with these details", content: { "application/json": { schema: { $ref: "#/components/schemas/BeneficiaryResponse" } } } },
          "400": { description: "Invalid request", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "401": { description: "invalid key or signature mismatch", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "403": { description: "Live Key before live mode is activated (`code: LIVE_MODE_NOT_ACTIVATED`)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "409": { description: "beneficiary_ref already used with different details", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/api/v1/payouts/create": {
      post: {
        tags: ["Payout"],
        summary: "Create a payout",
        description: "Pays an APPROVED beneficiary. Idempotent on `txnid`: the same `txnid` with the same amount and beneficiary returns the first payout (`200`, `reused: true`); with different values it is refused (`409`). Payouts at or above ₹50,000 wait for approval (`status: ON_HOLD`). Signed string: `txnid|amount|beneficiary|rail|purpose`.",
        requestBody: { required: true, content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/CreatePayoutRequest" },
            examples: { imps: { summary: "IMPS payout to a registered beneficiary", value: {
              key: "mk_test_xxx", txnid: "PO-9001", amount: "1500.00", beneficiary_ref: "vendor-7",
              rail: "IMPS", purpose: "vendor settlement", notify_url: "https://yoursite.com/payout-callback", hash: "<hex signature>",
            } } },
          },
          "application/x-www-form-urlencoded": { schema: { $ref: "#/components/schemas/CreatePayoutRequest" } },
        } },
        responses: {
          "201": { description: "Payout created", content: { "application/json": { schema: { $ref: "#/components/schemas/CreatePayoutResponse" } } } },
          "200": { description: "Existing payout returned (same txnid)", content: { "application/json": { schema: { $ref: "#/components/schemas/CreatePayoutResponse" } } } },
          "400": { description: "Invalid request", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "401": { description: "invalid key or signature mismatch", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "403": { description: "Live Key before live mode is activated (`code: LIVE_MODE_NOT_ACTIVATED`)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Beneficiary not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "409": { description: "Beneficiary not approved, insufficient payout balance, rail not possible for this amount or beneficiary, txnid reused with different values, or test/live mismatch", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/api/v1/reports/payins": {
      post: {
        tags: ["Pay-in"],
        summary: "Pay-in report for a date range",
        description: "Your own orders for a range of calendar days in India (at most 31), with totals by day and by flow. A Key only sees orders of its own mode. Signed string: `from|to`. The response carries `X-Report-Hash`, the SHA-256 of the report's content; the JSON repeats it as `report_hash`.",
        requestBody: { required: true, content: { "application/json": { schema: {
          type: "object", required: ["key", "from", "to", "hash"],
          properties: {
            key: { type: "string", example: "mk_test_xxx" },
            from: { type: "string", example: "2026-10-01" },
            to: { type: "string", example: "2026-10-31" },
            format: { type: "string", enum: ["json", "csv"], default: "json" },
            hash: { type: "string", description: "Signature over `from|to`." },
          },
        } } } },
        responses: {
          "200": { description: "The report (JSON, or CSV when `format` is `csv`)" },
          "400": { description: "Bad dates, or a range over 31 days", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "401": { description: "invalid key or signature mismatch", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "403": { description: "Live Key before live mode is activated (`code: LIVE_MODE_NOT_ACTIVATED`)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/api/v1/payouts/status": {
      post: {
        tags: ["Payout"],
        summary: "Get payout status",
        description: "Look up one payout by your `txnid` or Katana's `payout_id`. A Key only sees payouts of its own mode. Signed string: the `txnid` or `payout_id` you send.",
        requestBody: { required: true, content: {
          "application/json": { schema: { $ref: "#/components/schemas/PayoutStatusRequest" } },
          "application/x-www-form-urlencoded": { schema: { $ref: "#/components/schemas/PayoutStatusRequest" } },
        } },
        responses: {
          "200": { description: "Payout", content: { "application/json": { schema: { type: "object", properties: { payout: { $ref: "#/components/schemas/Payout" } } } } } },
          "401": { description: "invalid key or signature mismatch", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Payout not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      ApiKey: { type: "http", scheme: "bearer", description: "A v2 API key: `sk_test_…` creates test orders, `sk_live_…` live ones." },
    },
    schemas: {
      V2CreateOrder: {
        type: "object",
        required: ["amount", "reference"],
        properties: {
          amount: { type: "integer", description: "Minor units (paise).", example: 200000 },
          currency: { type: "string", default: "INR", enum: ["INR"] },
          reference: { type: "string", maxLength: 60, description: "Your own id for the order, unique within your account.", example: "inv-1001" },
          callback_url: { type: "string", format: "uri", description: "Where this order's webhook goes. Without it, the callback URL saved in the dashboard." },
          return_url: { type: "string", format: "uri", description: "Where the customer's browser is sent after paying." },
          flow: { type: "string", enum: ["P2P", "INTENT"], description: "Leave out to use the account's own setting." },
          metadata: { type: "object", additionalProperties: true, description: "Up to 20 keys of your own notes; given back when the order is read." },
        },
      },
      V2OrderCreated: {
        type: "object",
        properties: {
          order_id: { type: "string", example: "KTN_3f2b8c1e9a4d4e6f8b7a0c1d2e3f4a5b" },
          reference: { type: "string", example: "inv-1001" },
          status: { type: "string", enum: ["PENDING", "SUCCESS", "FAILED", "EXPIRED"], example: "PENDING" },
          checkout_url: { type: "string", format: "uri" },
          expires_at: { type: "string", format: "date-time", nullable: true },
        },
      },
      V2Order: {
        type: "object",
        description: "An order as v2 states it. The webhook body is these fields up to `gateway`.",
        properties: {
          event: { type: "string", nullable: true, enum: ["payment.success", "payment.failed", "payment.expired"], description: "null while the order is PENDING" },
          event_id: { type: "string", nullable: true, example: "evt_9c1d0e2f3a4b5c6d7e8f9a0b1c2d3e4f" },
          order_id: { type: "string", example: "KTN_3f2b8c1e9a4d4e6f8b7a0c1d2e3f4a5b" },
          reference: { type: "string", example: "inv-1001" },
          status: { type: "string", enum: ["PENDING", "SUCCESS", "FAILED", "EXPIRED"] },
          previous_status: { type: "string", enum: ["EXPIRED", "FAILED"], description: "Present only when SUCCESS follows EXPIRED or FAILED." },
          amount: { type: "integer", description: "Minor units (paise).", example: 200000 },
          currency: { type: "string", example: "INR" },
          rrn: { type: "string", nullable: true, description: "The bank's reference; null unless SUCCESS.", example: "123456789012" },
          rrn_is_synthetic: { type: "boolean", description: "true when Katana made the reference: it is on no bank statement." },
          paid_at: { type: "string", format: "date-time", nullable: true },
          gateway: { type: "string", nullable: true, description: "Always null." },
          checkout_url: { type: "string", format: "uri", nullable: true },
          expires_at: { type: "string", format: "date-time", nullable: true },
          created_at: { type: "string", format: "date-time" },
          livemode: { type: "boolean" },
          metadata: { type: "object", nullable: true, additionalProperties: true },
        },
      },
      V2Error: {
        type: "object",
        properties: {
          code: { type: "string", enum: Object.keys(V2_ERRORS), example: "ORDER_NOT_FOUND" },
          message: { type: "string", description: "For a person; branch on `code`." },
          reference: { type: "string", description: "The id of the request, also in the X-Request-Id header.", example: "req_5b1c0e2f3a4b5c6d7e8f9a0b" },
        },
      },
      CreateOrderRequest: {
        type: "object",
        required: ["key", "txnid", "amount", "hash"],
        properties: {
          key: { type: "string", description: "Public Checkout Key. `mk_test_…` creates a test order, `mk_live_…` a live one.", example: "mk_test_xxx" },
          txnid: { type: "string", maxLength: 60, description: "Your unique order id (idempotency key).", example: "ORDER-1001" },
          amount: { type: "string", description: "Major-unit amount as a string.", example: "499.00" },
          hash: { type: "string", description: "Signature over the order (see Authentication)." },
          productinfo: { type: "string", description: "Order description (must match what you signed).", example: "Order 1001" },
          firstname: { type: "string", description: "Customer name (also part of the legacy SHA-512 signature).", example: "Asha Kumar" },
          email: { type: "string", description: "Customer email (must match what you signed).", example: "buyer@example.com" },
          phone: { type: "string", description: "Customer mobile number.", example: "9999999999" },
          customer_vpa: { type: "string", description: "Payer (sender) UPI VPA.", example: "buyer@upi" },
          receiver_vpa: { type: "string", description: "Single receiver VPA (overrides banker default)." },
          receiver_vpas: { type: "array", items: { type: "string" }, maxItems: 30, description: "Receiver VPA pool with backup failover. Defaults to the banker's settlement VPA." },
          mode: { type: "string", enum: ["QR", "INTENT"], default: "QR", description: "QR shows a scannable code; INTENT returns app deeplinks." },
          currency: { type: "string", default: "INR", example: "INR" },
        },
      },
      CreateOrderResponse: {
        type: "object",
        properties: {
          verified: { type: "boolean", example: true },
          merchant: { type: "string", example: "K-001" },
          reused: { type: "boolean", description: "true when an existing order matched the txnid." },
          livemode: { type: "boolean", description: "false when the order was created with a test Key.", example: true },
          order: { $ref: "#/components/schemas/Order" },
          deeplinks: {
            type: "object",
            nullable: true,
            description: "null for a merchant paid on a gateway's page.",
            properties: {
              upi: { type: "string", example: "upi://pay?pa=...&am=499.00..." },
              paytm: { type: "string", example: "paytmmp://pay?..." },
              phonepe: { type: "string", example: "phonepe://pay?..." },
            },
          },
          upi_intent: { type: "string", nullable: true, description: "null for a merchant paid on a gateway's page.", example: "upi://pay?pa=...&am=499.00..." },
          qr_payload: { type: "string", nullable: true, description: "Render this string as a QR code. null for a merchant paid on a gateway's page.", example: "upi://pay?pa=...&am=499.00..." },
          gateway_url: { type: "string", description: "Only for a merchant paid on a gateway's own page: a link straight to that page. `pay_url` hands over to it too.", example: "https://katanapay.co/pay/<uuid>/go" },
          pay_url: { type: "string", description: "Hosted pay page — redirect the customer here.", example: "https://katanapay.co/pay/<uuid>" },
        },
      },
      Order: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid", description: "Internal order id — use for /api/pay-status/{id}." },
          order_id: { type: "string", example: "ORDER-1001" },
          amount: { type: "number", example: 499 },
          currency_code: { type: "string", example: "INR" },
          status: { type: "string", enum: ["PENDING", "SUCCESS", "FAILED", "EXPIRED"], example: "PENDING" },
        },
      },
      PayStatus: {
        type: "object",
        properties: {
          order_id: { type: "string", example: "ORDER-1001" },
          amount: { type: "number", example: 499 },
          status: { type: "string", enum: ["PENDING", "SUCCESS", "FAILED", "EXPIRED"], example: "SUCCESS" },
          terminal: { type: "boolean", description: "true once the status is final.", example: true },
          rrn: { type: "string", description: "Bank UTR / RRN once paid.", example: "455537238396" },
          livemode: { type: "boolean", description: "false for a test order.", example: true },
        },
      },
      RegisterBeneficiaryRequest: {
        type: "object",
        required: ["key", "hash", "beneficiary_ref", "name"],
        description: "Send `account_number` + `ifsc`, or `upi_id` (or both).",
        properties: {
          key: { type: "string", example: "mk_test_xxx" },
          hash: { type: "string", description: "Signature over `beneficiary_ref|name|account_number|ifsc|upi_id`." },
          beneficiary_ref: { type: "string", pattern: "^[A-Za-z0-9_-]{1,40}$", description: "Your id for this beneficiary.", example: "vendor-7" },
          name: { type: "string", maxLength: 100, example: "Asha Traders" },
          account_number: { type: "string", pattern: "^[A-Za-z0-9]{6,20}$", example: "001122334455" },
          ifsc: { type: "string", pattern: "^[A-Z]{4}0[A-Z0-9]{6}$", example: "HDFC0001234" },
          upi_id: { type: "string", example: "asha@okhdfc" },
          bank_name: { type: "string", description: "Display only; not signed." },
        },
      },
      BeneficiaryResponse: {
        type: "object",
        properties: {
          reused: { type: "boolean" },
          beneficiary: { type: "object", properties: {
            beneficiary_id: { type: "string", format: "uuid" },
            beneficiary_ref: { type: "string", example: "vendor-7" },
            status: { type: "string", enum: ["PENDING", "APPROVED", "REJECTED", "DISABLED"], example: "PENDING" },
            name: { type: "string" },
            account_last4: { type: "string", nullable: true, example: "4455" },
            ifsc: { type: "string", nullable: true },
            upi_id: { type: "string", nullable: true },
          } },
        },
      },
      CreatePayoutRequest: {
        type: "object",
        required: ["key", "hash", "txnid", "amount"],
        description: "Send exactly one of `beneficiary_ref` or `beneficiary_id`.",
        properties: {
          key: { type: "string", description: "`mk_test_…` pays out in the provider's sandbox; `mk_live_…` moves real money.", example: "mk_test_xxx" },
          hash: { type: "string", description: "Signature over `txnid|amount|beneficiary|rail|purpose`." },
          txnid: { type: "string", pattern: "^[A-Za-z0-9_-]{1,40}$", description: "Your unique payout id (idempotency key).", example: "PO-9001" },
          amount: { type: "string", pattern: "^\\d+(\\.\\d{1,2})?$", description: "Rupees as a string, at most 2 decimals. Signed exactly as sent.", example: "1500.00" },
          beneficiary_ref: { type: "string", example: "vendor-7" },
          beneficiary_id: { type: "string", format: "uuid" },
          rail: { type: "string", enum: ["IMPS", "NEFT", "RTGS", "UPI"], description: "Default: IMPS for a bank beneficiary, UPI for a UPI-only one. IMPS ≤ ₹5,00,000; RTGS ≥ ₹2,00,000." },
          purpose: { type: "string", maxLength: 50, example: "vendor settlement" },
          currency: { type: "string", enum: ["INR"], default: "INR" },
          notify_url: { type: "string", description: "Where the signed payout.status callback goes (http/https). Default: your webhook URL." },
        },
      },
      CreatePayoutResponse: {
        type: "object",
        properties: {
          payout: { $ref: "#/components/schemas/Payout" },
          reused: { type: "boolean", description: "true when an existing payout matched the txnid." },
          approval_required: { type: "boolean", description: "true when the payout waits for approval (≥ ₹50,000)." },
        },
      },
      PayoutStatusRequest: {
        type: "object",
        required: ["key", "hash"],
        description: "Send exactly one of `txnid` or `payout_id`.",
        properties: {
          key: { type: "string" },
          hash: { type: "string", description: "Signature over the `txnid` or `payout_id` you send." },
          txnid: { type: "string" },
          payout_id: { type: "string" },
        },
      },
      Payout: {
        type: "object",
        properties: {
          payout_id: { type: "string", example: "PO-3FA2C19B7D10" },
          txnid: { type: "string", example: "PO-9001" },
          status: { type: "string", enum: ["PROCESSING", "ON_HOLD", "SUCCESS", "FAILED", "REJECTED", "REVERSED"], example: "PROCESSING" },
          terminal: { type: "boolean", description: "true for SUCCESS, FAILED, REJECTED and REVERSED. SUCCESS can still become REVERSED." },
          amount: { type: "string", example: "1500.00" },
          currency: { type: "string", example: "INR" },
          rail: { type: "string", nullable: true, example: "IMPS" },
          beneficiary_id: { type: "string", format: "uuid" },
          utr: { type: "string", nullable: true, description: "Bank reference once paid.", example: "327012345470" },
          failure_reason: { type: "string", nullable: true },
          livemode: { type: "boolean" },
          created_at: { type: "string", format: "date-time" },
          completed_at: { type: "string", format: "date-time", nullable: true },
        },
      },
      LimitError: {
        type: "object",
        properties: {
          error: { type: "string", example: "amount is above the maximum of ₹5,000" },
          code: { type: "string", enum: ["AMOUNT_BELOW_MIN", "AMOUNT_ABOVE_MAX", "UPI_LIMIT_EXCEEDED", "DAILY_LIMIT_EXCEEDED", "RATE_LIMITED"] },
          field: { type: "string", example: "amount" },
          limit: { type: "number", example: 5000 },
          actual: { type: "number", example: 5000.01 },
        },
      },
      Error: {
        type: "object",
        properties: { error: { type: "string", example: "signature mismatch" } },
      },
    },
  },
  "x-webhooks": {
    "payment.status": {
      post: {
        summary: "Payment status webhook (Katana → your server)",
        description: [
          "When you set a Webhook URL in the dashboard, Katana POSTs a signed JSON event on each status change.",
          "Headers: `X-Event-Type`, `X-Timestamp`, `X-Payload-Hash` (sha256 of body), `X-Signature` = `HMAC_SHA256(webhook_secret, payloadHash + \".\" + timestamp)`, `X-Attempt`.",
          "Verify: reject if `X-Timestamp` skew > ±5 min; recompute and compare the signature (timing-safe); return 2xx.",
          "Retries: 1m → 5m → 15m → 1h → 6h → 24h then dead-letter. Make your handler idempotent.",
        ].join(" "),
      },
    },
    "payout.status": {
      post: {
        summary: "Payout status callback (Katana → your server)",
        description: [
          "Sent when a payout reaches SUCCESS, FAILED, REJECTED or REVERSED — once per status — to the payout's `notify_url`, else your webhook URL.",
          "JSON body: `EVENT` (`payout.status`), `PAYOUT_ID`, `ORDER_ID` (your txnid), `AMOUNT`, `CURRENCY_CODE` (`356`), `STATUS`, `RAIL`, `UTR`,",
          "`FAILURE_REASON`, `RESPONSE_DATE_TIME`, `LIVEMODE` (`false`, test payouts only) and `HASH`.",
          "Verify `HASH` exactly like the pay-in callback: every field except HASH, sorted by name (byte order), joined as `NAME=value` with `~`,",
          "your Salt (of the payout's mode) appended, SHA-256, uppercase hex. Empty values stay in (`UTR=`). Return 2xx; retries follow the schedule above.",
        ].join(" "),
      },
    },
  },
} as const;
