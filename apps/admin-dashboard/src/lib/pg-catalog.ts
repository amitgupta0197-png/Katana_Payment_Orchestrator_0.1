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

export type GatewayId = "PAYU" | "RAZORPAY" | "CASHFREE" | "CCAVENUE" | "PHONEPE" | "PAYTM" | "RUBYVAULT" | "ISMARTPAY";
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

/**
 * A second way to sign in to the same gateway, e.g. PayU pay-ins with a Client ID + Secret
 * (Payment Links API) instead of the Key + Salt. Its fields replace `fields` when chosen, and it
 * uses its own connector, so a saved mode always matches the code that will use it.
 */
export type AuthModeId = "key_salt" | "client_credentials";
export interface AuthMode {
  id: AuthModeId;
  label: string;
  fields: CredField[];
  /** Environment labels, when this mode talks to different hosts. */
  env?: Record<GatewayEnv, string>;
  creds?: string;
  note?: string;
}

export interface GatewayService {
  fields: CredField[];
  /** Other sign-in modes. The default mode (`fields`) is labelled `defaultAuthLabel`. */
  altAuth?: AuthMode[];
  defaultAuthLabel?: string;
  connector: boolean;
  env: Record<GatewayEnv, string>;   // how each environment is labelled in the UI
  note?: string;
  /** Pay-ins: which credentials the gateway issues, so a Client ID / Secret isn't misplaced. */
  creds?: string;
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
      creds: "Hosted checkout and UPI intent, signed with the Merchant Key + Salt.",
      defaultAuthLabel: "Key + Salt",
      fields: [
        { name: "mid_code", label: "Merchant ID (MID)", placeholder: "e.g. 8123456" },
        { name: "key", label: "Merchant Key", placeholder: "PayU key" },
        { name: "salt", label: "Salt", secret: true },
      ],
      altAuth: [{
        id: "client_credentials", label: "Client ID + Secret",
        env: { TEST: "Test (uatoneapi.payu.in)", PROD: "Live (oneapi.payu.in)" },
        creds: "PayU Payment Links: the customer pays on a PayU-hosted page (cards, UPI, netbanking). No UPI intent in this mode. The Client ID + Secret must have the create_payment_links scope (and read_payment_links, if PayU issues it separately).",
        fields: [
          { name: "mid_code", label: "Merchant ID (MID)", placeholder: "e.g. 8123456", pattern: "^\\d{1,20}$" },
          { name: "key", label: "Client ID" },
          { name: "salt", label: "Client Secret", secret: true },
        ],
      }],
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
      creds: "Razorpay's Key ID and Key Secret are its Client ID and Client Secret.",
      note: "Add Katana's payment events URL in Razorpay → Settings → Webhooks (events order.paid and payment.failed), with the same webhook secret as here. UPI intent needs S2S UPI enabled on the account.",
      fields: [
        { name: "key", label: "Client ID (Key ID)", placeholder: "rzp_test_…", pattern: "^rzp_(test|live)_[A-Za-z0-9]+$" },
        { name: "salt", label: "Client Secret (Key Secret)", secret: true },
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
      creds: "Cashfree's App ID and Secret Key are its Client ID (x-client-id) and Client Secret (x-client-secret).",
      note: "Katana sends its payment events URL with every order, so there is nothing to set up for webhooks.",
      fields: [
        { name: "key", label: "Client ID (App ID)" },
        { name: "salt", label: "Client Secret (Secret Key)", secret: true },
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
      creds: "CCAvenue doesn't use a Client ID / Secret. Ask CCAvenue for the Access Code and Working Key.",
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
      creds: "Enter the Client ID, Client Secret and Client Version from the PhonePe dashboard.",
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
      creds: "Paytm pay-ins don't use a Client ID / Secret. Ask Paytm for the MID and Merchant Key.",
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
    id: "RUBYVAULT", name: "RubyVault", logo: null, color: "#B0123A",
    payin: {
      connector: true,
      env: { TEST: "Test (enter RubyVault's test URL below)", PROD: "Live (rubyvault.tech)" },
      creds: "RubyVault doesn't use a Client ID / Secret. Ask RubyVault for the Account Code and Secret Key.",
      note: "Hosted UPI QR checkout (no UPI intent). RubyVault's live minimum is ₹500. Give RubyVault Katana's payment events URL as the callback URL; it is set once at onboarding, not per order.",
      fields: [
        { name: "key", label: "Account Code", placeholder: "Account Code from RubyVault" },
        { name: "salt", label: "Secret Key", secret: true },
        { name: "api_base", label: "API base URL (required for Test)", placeholder: "https://rubyvault.tech", pattern: "^https://[A-Za-z0-9.-]+(:\\d+)?/?$", optional: true },
      ],
    },
    // RubyVault's API document has no payout API yet.
    payout: null,
  },
  {
    id: "ISMARTPAY", name: "iSmartPay", logo: null, color: "#1B7F5C",
    payin: {
      connector: true,
      env: { TEST: "Test (enter iSmartPay's test URL below)", PROD: "Live (pay.ismartpay.co.in)" },
      creds: "iSmartPay doesn't use a Client ID / Secret. iSmartPay support gives the MID; the API key is generated in the iSmartPay partner panel.",
      note: "Hosted checkout (no UPI intent), ₹100 to ₹2,00,000 per payment. Katana sends its return and payment events URLs with every order; nothing to set in iSmartPay.",
      fields: [
        { name: "key", label: "MID", placeholder: "MID from iSmartPay support" },
        { name: "salt", label: "API key", secret: true },
        { name: "api_base", label: "API base URL (required for Test)", placeholder: "https://pay.ismartpay.co.in", pattern: "^https://[A-Za-z0-9.-]+(:\\d+)?/?$", optional: true },
      ],
    },
    payout: {
      connector: true, balance: true, webhook: "dashboard",
      env: { TEST: "Test (enter iSmartPay's test URL below)", PROD: "Live (pay.ismartpay.co.in)" },
      note: "iSmartPay pays on IMPS, NEFT and RTGS (no UPI) from the merchant's iSmartPay payout wallet, ₹500 minimum per payout. iSmartPay must whitelist Katana's server IP (72.61.227.233) on both its payout and pay hosts. Ask iSmartPay support to set Katana's webhook URL as the payout callback URL.",
      fields: [
        { name: "mid", label: "MID", placeholder: "MID from iSmartPay support", show: true },
        { name: "api_key", label: "API key", secret: true },
        { name: "default_mobile", label: "Contact mobile sent with payouts", placeholder: "10-digit mobile", pattern: "^[6-9]\\d{9}$", show: true },
        { name: "api_base", label: "API base URL (required for Test)", placeholder: "https://pay.ismartpay.co.in", pattern: "^https://[A-Za-z0-9.-]+(:\\d+)?/?$", optional: true, show: true },
      ],
    },
  },
];

export function gatewayDef(id: string): GatewayDef | undefined {
  return GATEWAYS.find((g) => g.id === id);
}

/** The fields a service asks for in the chosen sign-in mode (the default mode when unknown). */
export function authFields(svc: GatewayService, auth?: string | null): CredField[] {
  return svc.altAuth?.find((m) => m.id === auth)?.fields ?? svc.fields;
}

export function gatewayName(id: string | null | undefined): string {
  return (id && gatewayDef(id)?.name) || id || "—";
}

/** Check submitted values against a service's fields. Returns the cleaned values or an error. */
export function validateCredFields(svc: GatewayService, input: Record<string, unknown>, auth?: string | null): { values?: Record<string, string>; error?: string } {
  const values: Record<string, string> = {};
  for (const f of authFields(svc, auth)) {
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
