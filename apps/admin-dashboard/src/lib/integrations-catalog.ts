// Static catalogue of every external integration Katana ships with.
// Promoted to a DB table once ops needs runtime edits (PRODUCT_VISION §3.4).

export type IntegrationStatus = "not_started" | "scaffold" | "implemented";
export type IntegrationCategory =
  | "PG (Pay-in)" | "Bank Payout" | "Crypto VASP" | "UPI Rail"
  | "Card Network" | "Settlement Partner" | "Risk / KYB"
  | "Reconciliation" | "Notification" | "Observability" | "Other";

export interface Integration {
  code: string;
  name: string;
  category: IntegrationCategory;
  status: IntegrationStatus;
  secret_ref?: string;        // vault://… path
  webhook_url?: string;       // public callback URL
  docs_url?: string;
  notes?: string;
}

export const INTEGRATIONS: Integration[] = [
  // PG / payin
  { code: "POOLPAY",   name: "Katana Pay",     category: "PG (Pay-in)", status: "implemented", secret_ref: "vault://poolpay/live/secret", webhook_url: "/api/vendors/poolpay/callback" },
  { code: "QUICKPAY",  name: "Quickpay",       category: "PG (Pay-in)", status: "implemented", secret_ref: "vault://quickpay/live/secret", webhook_url: "/api/vendors/quickpay/callback" },
  { code: "RAZORPAY",  name: "Razorpay",       category: "PG (Pay-in)", status: "scaffold" },
  { code: "PAYU",      name: "PayU",           category: "PG (Pay-in)", status: "scaffold" },
  { code: "CASHFREE",  name: "Cashfree",       category: "PG (Pay-in)", status: "scaffold" },

  // Bank payout
  { code: "RZPX",      name: "RazorpayX Payouts",   category: "Bank Payout", status: "scaffold" },
  { code: "CF_PO",     name: "Cashfree Payouts",    category: "Bank Payout", status: "scaffold" },
  { code: "ICICI_CEC", name: "ICICI CE-Connect",    category: "Bank Payout", status: "not_started" },
  { code: "POOLPAY_PO",name: "Katana Pay Payout",   category: "Bank Payout", status: "implemented" },
  { code: "QUICKPAY_PO",name:"Quickpay Payout",     category: "Bank Payout", status: "implemented" },

  // Crypto VASPs
  { code: "BINANCE_OTC",name: "Binance OTC",   category: "Crypto VASP", status: "not_started" },
  { code: "OKX",       name: "OKX",            category: "Crypto VASP", status: "not_started" },
  { code: "BITGET",    name: "Bitget",         category: "Crypto VASP", status: "not_started" },
  { code: "ONMETA",    name: "OnMeta",         category: "Crypto VASP", status: "not_started" },
  { code: "TRANSAK",   name: "Transak",        category: "Crypto VASP", status: "not_started" },

  // UPI / Card
  { code: "NPCI_UPI",  name: "NPCI UPI",       category: "UPI Rail",      status: "scaffold" },
  { code: "VISA",      name: "Visa",           category: "Card Network",  status: "not_started" },
  { code: "MC",        name: "Mastercard",     category: "Card Network",  status: "not_started" },
  { code: "RUPAY",     name: "RuPay",          category: "Card Network",  status: "not_started" },

  // Settlement partners
  { code: "HDFC_SET",  name: "HDFC Settlement",      category: "Settlement Partner", status: "not_started" },
  { code: "ICICI_SET", name: "ICICI Settlement",     category: "Settlement Partner", status: "not_started" },

  // Risk / KYB
  { code: "OFAC",      name: "OFAC sanctions list",  category: "Risk / KYB", status: "scaffold" },
  { code: "UN_SAN",    name: "UN sanctions list",    category: "Risk / KYB", status: "scaffold" },
  { code: "EU_SAN",    name: "EU sanctions list",    category: "Risk / KYB", status: "scaffold" },

  // Observability
  { code: "OTEL",      name: "OpenTelemetry collector", category: "Observability", status: "scaffold" },
  { code: "GRAFANA",   name: "Grafana / Prometheus",    category: "Observability", status: "not_started" },

  // Notification
  { code: "TELEGRAM_BOT", name: "Telegram bot (AI agents)", category: "Notification", status: "not_started", notes: "Phase D" },
];

export const INTEGRATION_CATEGORIES: IntegrationCategory[] = [
  "PG (Pay-in)", "Bank Payout", "Crypto VASP", "UPI Rail", "Card Network",
  "Settlement Partner", "Risk / KYB", "Reconciliation", "Notification",
  "Observability", "Other",
];
