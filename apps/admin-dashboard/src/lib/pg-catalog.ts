// Payment gateways a merchant can connect, and what each one needs.
//
// Shared by the admin UI (which fields to ask for) and the API routes (what to validate).
// No secrets here. A merchant connects ONE gateway for pay-ins and ONE for payouts; they may
// differ.
//
// `connector: true` means Katana actually routes money through that gateway today. Connectors
// other than PayU run in PROD only once switched on (PAYIN_CONNECTORS_PROD /
// PAYOUT_CONNECTORS_PROD). The others
// can be selected and their credentials saved, but the merchant keeps using Katana's current
// route until their connector ships — the UI says so. Every money path checks the gateway id
// before using stored credentials, so saving a not-yet-connected gateway can't misroute orders.

export type GatewayId = "PAYU" | "RAZORPAY" | "CASHFREE" | "CCAVENUE" | "PHONEPE" | "PAYTM" | "POOLPAY";
export type GatewayEnv = "TEST" | "PROD";

export interface CredField {
  name: string;          // key in the saved credential blob
  label: string;
  secret?: boolean;      // write-only; shown as a password field and never echoed back
  show?: boolean;        // safe to show in full on the saved summary (otherwise last 4 only)
  optional?: boolean;
  placeholder?: string;
  pattern?: string;      // regex the value must match (checked server-side too)
}

export interface GatewayService {
  fields: CredField[];
  connector: boolean;
  env: Record<GatewayEnv, string>;   // how each environment is labelled in the UI
  note?: string;
  /** Payouts: how the gateway learns Katana's webhook URL. */
  webhook?: "api" | "dashboard" | "per_transfer";
  /** Payouts: Katana can read the account balance. */
  balance?: boolean;
}

export interface GatewayDef {
  id: GatewayId;
  name: string;
  /** Logo in /public/gateways, or null for a lettered tile. */
  logo: string | null;
  /** Brand colour for the lettered tile and accents. */
  color: string;
  payin: GatewayService;
  payout: GatewayService | null;     // null: the gateway has no payout product we can connect
}

export const GATEWAYS: GatewayDef[] = [
  {
    id: "PAYU", name: "PayU", logo: "/gateways/payu.png", color: "#A6C307",
    payin: {
      connector: true,
      env: { TEST: "Test (test.payu.in)", PROD: "Live (secure.payu.in)" },
      fields: [
        { name: "mid_code", label: "Merchant ID (MID)", placeholder: "e.g. 8123456" },
        { name: "key", label: "Merchant Key", placeholder: "PayU key" },
        { name: "salt", label: "Salt", secret: true },
      ],
    },
    payout: {
      connector: true, webhook: "api", balance: true,
      env: { TEST: "UAT (uatoneapi.payu.in)", PROD: "Live (payout.payumoney.com)" },
      note: "From the PayU Payouts dashboard. The payout merchant ID is not the payment MID.",
      fields: [
        { name: "client_id", label: "Client ID" },
        { name: "client_secret", label: "Client Secret", secret: true },
        { name: "payout_merchant_id", label: "Payout Merchant ID", placeholder: "e.g. 1111122", pattern: "^\\d{1,20}$", show: true },
      ],
    },
  },
  {
    id: "RAZORPAY", name: "Razorpay", logo: "/gateways/razorpay.svg", color: "#0C2451",
    payin: {
      connector: true,
      env: { TEST: "Test mode (rzp_test_…)", PROD: "Live mode (rzp_live_…)" },
      note: "Add Katana's payment events URL in Razorpay → Settings → Webhooks (events order.paid and payment.failed), with the same webhook secret as here. UPI intent needs S2S UPI enabled on the account.",
      fields: [
        { name: "key", label: "Key ID", placeholder: "rzp_test_…", pattern: "^rzp_(test|live)_[A-Za-z0-9]+$" },
        { name: "salt", label: "Key Secret", secret: true },
        { name: "webhook_secret", label: "Webhook Secret", secret: true, optional: true },
        { name: "mid_code", label: "Merchant ID", optional: true },
      ],
    },
    payout: {
      connector: true, webhook: "dashboard",
      env: { TEST: "Test mode", PROD: "Live mode" },
      note: "RazorpayX. Uses the Key ID / Secret plus the RazorpayX account number money is paid from. Add Katana's webhook URL (payout events) in RazorpayX → Settings → Webhooks, with the same webhook secret as here.",
      fields: [
        { name: "key_id", label: "Key ID", placeholder: "rzp_test_…", pattern: "^rzp_(test|live)_[A-Za-z0-9]+$" },
        { name: "key_secret", label: "Key Secret", secret: true },
        { name: "account_number", label: "RazorpayX Account Number", pattern: "^\\d{6,20}$" },
        { name: "webhook_secret", label: "Webhook Secret", secret: true, optional: true },
      ],
    },
  },
  {
    id: "CASHFREE", name: "Cashfree Payments", logo: "/gateways/cashfree.svg", color: "#00AD5B",
    payin: {
      connector: true,
      env: { TEST: "Sandbox (sandbox.cashfree.com)", PROD: "Production (api.cashfree.com)" },
      note: "Katana sends its payment events URL with every order, so there is nothing to set up for webhooks.",
      fields: [
        { name: "key", label: "App ID (x-client-id)" },
        { name: "salt", label: "Secret Key (x-client-secret)", secret: true },
        { name: "mid_code", label: "Merchant ID", optional: true },
      ],
    },
    payout: {
      connector: true, webhook: "dashboard",
      env: { TEST: "Sandbox", PROD: "Production" },
      note: "Cashfree Payouts has its own Client ID and Secret, separate from the payment gateway keys. Whitelist Katana's server IP under Payouts → Developers → Two-Factor Authentication, and add Katana's webhook URL (v2) under Payouts → Developers → Webhooks.",
      fields: [
        { name: "client_id", label: "Payouts Client ID" },
        { name: "client_secret", label: "Payouts Client Secret", secret: true },
      ],
    },
  },
  {
    id: "CCAVENUE", name: "CCAvenue", logo: null, color: "#1F7EC2",
    payin: {
      connector: true,
      env: { TEST: "Test (test.ccavenue.com)", PROD: "Live (secure.ccavenue.com)" },
      note: "CCAvenue encrypts each request with the Working Key. Hosted checkout only: CCAvenue has no UPI intent API. Whitelist Katana's server IP for CCAvenue's status API.",
      fields: [
        { name: "mid_code", label: "Merchant ID", pattern: "^\\d{1,20}$" },
        { name: "key", label: "Access Code" },
        { name: "salt", label: "Working Key", secret: true },
      ],
    },
    payout: null,
  },
  {
    id: "PHONEPE", name: "PhonePe Payment Gateway", logo: "/gateways/phonepe.svg", color: "#5F259F",
    payin: {
      connector: true,
      env: { TEST: "UAT (api-preprod.phonepe.com)", PROD: "Production (api.phonepe.com)" },
      note: "For webhooks, add Katana's payment events URL in the PhonePe dashboard with a username and password, and enter the same two here.",
      fields: [
        { name: "key", label: "Client ID" },
        { name: "salt", label: "Client Secret", secret: true },
        { name: "client_version", label: "Client Version", placeholder: "e.g. 1", pattern: "^\\d{1,4}$" },
        { name: "mid_code", label: "Merchant ID", optional: true },
        { name: "webhook_username", label: "Webhook username", optional: true },
        { name: "webhook_password", label: "Webhook password", secret: true, optional: true },
      ],
    },
    payout: null,
  },
  {
    id: "PAYTM", name: "Paytm Payment Gateway", logo: "/gateways/paytm.svg", color: "#00BAF2",
    payin: {
      connector: true,
      env: { TEST: "Staging (securegw-stage.paytm.in)", PROD: "Production (securegw.paytm.in)" },
      note: "Optionally add Katana's payment events URL as the payment notification URL in the Paytm dashboard.",
      fields: [
        { name: "key", label: "MID" },
        { name: "salt", label: "Merchant Key", secret: true },
        { name: "website", label: "Website name", placeholder: "WEBSTAGING or DEFAULT" },
      ],
    },
    payout: {
      connector: true, webhook: "per_transfer",
      env: { TEST: "Staging", PROD: "Production" },
      note: "Paytm Payouts pays from a sub-wallet of the merchant's Paytm for Business account. Katana sends its callback URL with every transfer; nothing to set in Paytm.",
      fields: [
        { name: "mid", label: "MID", show: true },
        { name: "merchant_key", label: "Merchant Key", secret: true },
        { name: "subwallet_guid", label: "Sub-wallet GUID" },
      ],
    },
  },
  {
    id: "POOLPAY", name: "PoolPay", logo: null, color: "#0B5FFF",
    payin: {
      connector: true,
      env: { TEST: "UAT (enter PoolPay's UAT URL below)", PROD: "Production (gateway.pp-007.com)" },
      note: "Hosted checkout and UPI intent. PoolPay must whitelist Katana's server IP (72.61.227.233). PoolPay reports results to the return URL Katana sends with each order; optionally also add Katana's payment events URL in the PoolPay portal.",
      fields: [
        { name: "key", label: "Pay ID", placeholder: "16-digit Pay ID from PoolPay", pattern: "^\\d{1,19}$" },
        { name: "salt", label: "Secret key", secret: true },
        { name: "api_base", label: "API base URL (required for UAT)", placeholder: "https://gateway.pp-007.com", pattern: "^https://[A-Za-z0-9.-]+(:\\d+)?/?$", optional: true },
      ],
    },
    payout: {
      connector: true, balance: true, webhook: "dashboard",
      env: { TEST: "UAT (enter PoolPay's UAT URL below)", PROD: "Production (payout.pp-007.com)" },
      note: "PoolPay pays on IMPS, RTGS and UPI (no NEFT) from the merchant's PoolPay payout wallet. PoolPay must whitelist Katana's server IP (72.61.227.233). Add Katana's webhook URL as the payout call-back URL in the PoolPay merchant portal.",
      fields: [
        { name: "pay_id", label: "Pay ID", placeholder: "16-digit Pay ID from PoolPay", pattern: "^\\d{1,19}$", show: true },
        { name: "salt", label: "Salt (hash key)", secret: true },
        { name: "default_mobile", label: "Contact mobile sent with payouts", placeholder: "10-digit mobile", pattern: "^[6-9]\\d{9}$", show: true },
        { name: "api_base", label: "API base URL (required for UAT)", placeholder: "https://payout.pp-007.com", pattern: "^https://[A-Za-z0-9.-]+(:\\d+)?/?$", optional: true, show: true },
      ],
    },
  },
];

export function gatewayDef(id: string): GatewayDef | undefined {
  return GATEWAYS.find((g) => g.id === id);
}

export function gatewayName(id: string | null | undefined): string {
  return (id && gatewayDef(id)?.name) || id || "—";
}

/** Check submitted values against a service's fields. Returns the cleaned values or an error. */
export function validateCredFields(svc: GatewayService, input: Record<string, unknown>): { values?: Record<string, string>; error?: string } {
  const values: Record<string, string> = {};
  for (const f of svc.fields) {
    const raw = input[f.name];
    const v = typeof raw === "string" ? raw.trim() : "";
    if (!v) {
      if (f.optional) continue;
      return { error: `${f.label} is required` };
    }
    if (v.length > 2048) return { error: `${f.label} is too long` };
    if (f.pattern && !new RegExp(f.pattern).test(v)) return { error: `${f.label} doesn't look right` };
    values[f.name] = v;
  }
  return { values };
}

/** Last 4 characters, for showing which key is saved without showing the key. */
export function hint(v: string | undefined | null): string {
  if (!v) return "—";
  return v.length > 4 ? `••••${v.slice(-4)}` : "••••";
}
