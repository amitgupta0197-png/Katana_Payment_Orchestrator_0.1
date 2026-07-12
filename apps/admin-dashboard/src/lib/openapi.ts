// OpenAPI 3.0 spec for the public Katana Pay integration API. Single source of
// truth — served as JSON at /api/openapi and rendered as Swagger UI at /developers.

export const openapiSpec = {
  openapi: "3.0.3",
  info: {
    title: "Katana Pay API",
    version: "1.0.0",
    description: [
      "Server-to-server (S2S) UPI pay-in API for integrating Katana Pay into your platform.",
      "",
      "## Authentication",
      "Each request is authenticated per-merchant with a **Checkout Key + Salt** pair",
      "(issued in the Katana dashboard). You send the public **Key** and a **signature**",
      "(`hash`) of the order fields; the **Salt** stays on your server and is never sent.",
      "",
      "**Signature** — pick the scheme chosen when the Key + Salt was issued:",
      "- `HMAC_SHA256`: `HMAC_SHA256(key + salt, \"txnid|amount|productinfo|email\")` (hex)",
      "- `PAYU_SHA512`: `sha512(\"key|txnid|amount|productinfo|firstname|email|||||||||||salt\")` (hex)",
      "",
      "## Flow",
      "1. `POST /api/v1/katana-pay/order` with the signed order → get QR / deeplinks / `pay_url`.",
      "2. Show the customer the QR or redirect them to `pay_url`.",
      "3. Receive the result via **webhook** (configured in the dashboard) or by polling",
      "   `GET /api/pay-status/{id}` until `terminal: true`.",
      "",
      "## Sandbox",
      "While in sandbox, the amount's last two paise digits force outcomes:",
      "`.99` → success (~8s), `.11` → expired, `.13` → failed; anything else stays PENDING.",
    ].join("\n"),
  },
  servers: [{ url: "https://katanapay.co", description: "Production" }],
  tags: [
    { name: "Pay-in", description: "Create and track S2S UPI pay-in orders" },
  ],
  paths: {
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
                    key: "mk_xxx",
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
          "403": { description: "Branch is blocked", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
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
  },
  components: {
    schemas: {
      CreateOrderRequest: {
        type: "object",
        required: ["key", "txnid", "amount", "hash"],
        properties: {
          key: { type: "string", description: "Public Checkout Key (mk_…).", example: "mk_xxx" },
          txnid: { type: "string", maxLength: 60, description: "Your unique order id (idempotency key).", example: "ORDER-1001" },
          amount: { type: "string", description: "Major-unit amount as a string.", example: "499.00" },
          hash: { type: "string", description: "Signature over the order (see Authentication)." },
          productinfo: { type: "string", description: "Order description (must match what you signed).", example: "Order 1001" },
          firstname: { type: "string", description: "Customer name (also part of the PAYU signature).", example: "Asha Kumar" },
          email: { type: "string", description: "Customer email (must match what you signed).", example: "buyer@example.com" },
          phone: { type: "string", description: "Customer mobile number.", example: "9999999999" },
          customer_vpa: { type: "string", description: "Payer (sender) UPI VPA.", example: "buyer@upi" },
          receiver_vpa: { type: "string", description: "Single receiver VPA (overrides branch default)." },
          receiver_vpas: { type: "array", items: { type: "string" }, maxItems: 30, description: "Receiver VPA pool with backup failover. Defaults to the branch's settlement VPA." },
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
          order: { $ref: "#/components/schemas/Order" },
          deeplinks: {
            type: "object",
            properties: {
              upi: { type: "string", example: "upi://pay?pa=...&am=499.00..." },
              paytm: { type: "string", example: "paytmmp://pay?..." },
              phonepe: { type: "string", example: "phonepe://pay?..." },
            },
          },
          upi_intent: { type: "string", example: "upi://pay?pa=...&am=499.00..." },
          qr_payload: { type: "string", description: "Render this string as a QR code.", example: "upi://pay?pa=...&am=499.00..." },
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
  },
} as const;
