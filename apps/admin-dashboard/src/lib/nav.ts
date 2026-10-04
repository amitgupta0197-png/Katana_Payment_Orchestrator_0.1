import { ListChecks, ArrowRightLeft,
  LayoutDashboard,
  BookOpen,
  GitMerge,
  Banknote,
  Send,
  Inbox,
  Users,
  Percent,
  ShieldAlert,
  FileCheck2,
  BarChart3,
  CreditCard,
  Network,
  Workflow,
  Globe,
  Coins,
  Droplets,
  UserCog,
  KeyRound,
  Shield,
  Store,
  UserPlus,
  Receipt,
  Wallet,
  Banknote as Cash,
  Activity,
  Sliders,
  ScrollText,
  Headphones,
  Bot,
  Rocket,
  FileSearch,
  Briefcase,
  FileSpreadsheet,
  QrCode,
  ArrowLeftRight,
  Smartphone,
  Building2,
  Landmark,
  Search,
  type LucideIcon,
} from "lucide-react";

export type NavPersona =
  | "SUPER_ADMIN" | "ADMIN" | "PROVIDER" | "MERCHANT"
  | "OPERATOR" | "COMPLIANCE" | "FINANCE" | "RISK" | "SUPPORT";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  status: "live" | "read-only" | "scaffold";
  group: "Overview" | "Provider Management" | "Payment Management" | "Money Movement" | "DT Business" | "Risk & Compliance" | "Operations" | "Admin";
  /** Personas that should see this nav entry. Defaults to SUPER_ADMIN only. */
  personas?: NavPersona[];
}

// Persona buckets — used by Sidebar to filter the full list before render so
// PROVIDER/MERCHANT never see admin-only links pointing at endpoints they
// can't reach. SUPER_ADMIN always sees everything; the other two see a
// curated subset that matches their own portal entries.
export const SHARED_PERSONAS: NavPersona[] = ["SUPER_ADMIN", "PROVIDER", "MERCHANT"];
export const PROVIDER_NAV: NavPersona[] = ["SUPER_ADMIN", "PROVIDER"];
export const MERCHANT_NAV: NavPersona[] = ["SUPER_ADMIN", "MERCHANT"];
// FIFO ops console — visible to super-admins and the operators who work the queue.
export const OPERATOR_NAV: NavPersona[] = ["SUPER_ADMIN", "OPERATOR"];

export function filterNavForPersona(items: NavItem[], persona: NavPersona): NavItem[] {
  return items.filter((i) => {
    const allowed = i.personas ?? ["SUPER_ADMIN"];
    return allowed.includes(persona);
  });
}

// Curated nav for the back-office / internal personas. These previously fell back
// to the full ~60-item super-admin menu; here each sees only the consoles relevant
// to their job. Nothing is removed from the app — every page stays reachable by URL
// and the ⌘K command palette; this only declutters the sidebar (presentation only).
const CURATED_NAV: Partial<Record<NavPersona, string[]>> = {
  OPERATOR:   ["/", "/orders", "/gateway-health", "/mid-switch", "/operator", "/status-intelligence", "/transaction-intel", "/fifo-dashboard", "/security"],
  FINANCE:    ["/", "/status-intelligence", "/transaction-intel", "/fifo-dashboard", "/payouts", "/fifo-settlements", "/fifo-reconciliation", "/fifo-reports", "/ledger", "/settlement-engine", "/settlement", "/reserves", "/chargebacks", "/dt-dashboard", "/dt-purchases", "/dt-refills", "/security"],
  RISK:       ["/", "/status-intelligence", "/transaction-intel", "/fifo-dashboard", "/forensics", "/cases", "/risk", "/risk/aml", "/risk/payin-flags", "/chargebacks", "/fifo-reports", "/fifo-controls", "/tsps", "/banks", "/security"],
  COMPLIANCE: ["/", "/forensics", "/cases", "/kyb", "/disputes", "/chargebacks", "/risk/aml", "/risk/payin-flags", "/fifo-controls", "/fifo-reports", "/tsps", "/banks", "/security"],
  SUPPORT:    ["/", "/orders", "/api-log", "/support-bot", "/payin-data", "/payout-data", "/summary", "/security"],
};

// Resolve the nav a given persona should see. SUPER_ADMIN/ADMIN see everything;
// PROVIDER/MERCHANT use their existing tag-based subset; the internal personas use
// the curated allow-list above; any unknown persona safely falls back to the full list.
export function personaNav(items: NavItem[], persona: NavPersona): NavItem[] {
  if (persona === "SUPER_ADMIN" || persona === "ADMIN") return filterNavForPersona(items, "SUPER_ADMIN");
  if (persona === "PROVIDER" || persona === "MERCHANT") return filterNavForPersona(items, persona);
  const allow = CURATED_NAV[persona];
  if (allow) return items.filter((i) => allow.includes(i.href));
  return filterNavForPersona(items, "SUPER_ADMIN");
}

export const navItems: NavItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard, status: "live", group: "Overview", personas: SHARED_PERSONAS },
  { href: "/admin-log", label: "Admin Log", icon: ScrollText, status: "live", group: "Overview" },

  // The chain a banker's MIDs come from: Bank → TSP → Banker (lib/chain). Staff only.
  { href: "/tsps",  label: "TSPs / Providers", icon: Building2, status: "live", group: "Provider Management", personas: ["SUPER_ADMIN", "ADMIN", "COMPLIANCE", "RISK", "OPERATOR", "FINANCE"] },
  { href: "/banks", label: "Banks",            icon: Landmark,  status: "live", group: "Provider Management", personas: ["SUPER_ADMIN", "ADMIN", "COMPLIANCE", "RISK", "OPERATOR", "FINANCE"] },

  { href: "/merchants",        label: "Merchants",       icon: UserPlus, status: "live", group: "Payment Management" },
  { href: "/sub-mids",         label: "Sub-MIDs",        icon: Network,  status: "live", group: "Payment Management" },
  { href: "/bankers",        label: "Banker",          icon: Store,    status: "live", group: "Payment Management" },
  { href: "/merchant-config",  label: "Banker Config",   icon: Sliders,  status: "live", group: "Payment Management" },
  // Pay-in flows: the P2P / Intent / Both bifurcation, and one sub-module per flow.
  { href: "/merchant-readiness", label: "Merchant readiness", icon: ListChecks, status: "live", group: "Payment Management" },
  { href: "/payin-flows",        label: "Pay-in Flows",    icon: ArrowLeftRight, status: "live", group: "Payment Management" },
  { href: "/payin-flows/p2p",    label: "P2P Pay-ins",     icon: Smartphone,     status: "live", group: "Payment Management" },
  { href: "/payin-flows/intent", label: "Intent Pay-ins",  icon: Building2,      status: "live", group: "Payment Management" },
  // The order desk and the v2 operations screens. Open to every staff role, like their APIs.
  { href: "/orders",           label: "Order search",    icon: Search,     status: "live", group: "Payment Management", personas: ["SUPER_ADMIN", "ADMIN", "OPERATOR", "COMPLIANCE", "FINANCE", "RISK", "SUPPORT"] },
  { href: "/gateway-health",   label: "Gateway health",  icon: Activity,   status: "live", group: "Payment Management", personas: ["SUPER_ADMIN", "ADMIN", "OPERATOR", "COMPLIANCE", "FINANCE", "RISK", "SUPPORT"] },
  { href: "/gateway-golive",   label: "Gateway go-live", icon: Rocket,     status: "live", group: "Payment Management", personas: ["SUPER_ADMIN", "ADMIN", "OPERATOR", "COMPLIANCE", "FINANCE", "RISK", "SUPPORT"] },
  { href: "/webhook-settings", label: "Webhook settings", icon: Workflow,  status: "live", group: "Payment Management", personas: ["SUPER_ADMIN", "ADMIN", "OPERATOR", "COMPLIANCE", "FINANCE", "RISK", "SUPPORT"] },
  { href: "/api-log",          label: "API request log", icon: ScrollText, status: "live", group: "Payment Management", personas: ["SUPER_ADMIN", "ADMIN", "OPERATOR", "COMPLIANCE", "FINANCE", "RISK", "SUPPORT"] },
  { href: "/qr-switch",        label: "QR Operations",   icon: QrCode,   status: "live", group: "Payment Management", personas: ["SUPER_ADMIN", "ADMIN", "OPERATOR"] },
  { href: "/transactions",     label: "Transactions",    icon: Receipt,  status: "live", group: "Payment Management" },
  // Personas match the /api/statements gate — a link to an endpoint the viewer is refused by
  // is worse than no link.
  { href: "/statements",       label: "Statements",      icon: FileSpreadsheet, status: "live", group: "Payment Management", personas: ["SUPER_ADMIN", "ADMIN", "FINANCE"] },
  { href: "/payin-order",      label: "Payin Order",     icon: Receipt,  status: "live", group: "Payment Management" },
  { href: "/summary",          label: "Summary",         icon: BarChart3,status: "live", group: "Payment Management" },
  { href: "/payout-order",     label: "Payout Order",    icon: Send,     status: "live", group: "Payment Management" },
  { href: "/merchant-wallet",  label: "Banker Wallet",   icon: Wallet,   status: "live", group: "Payment Management" },
  { href: "/fund",             label: "Fund",            icon: Cash,     status: "live", group: "Payment Management" },
  { href: "/payin-data",       label: "Payin Data",      icon: Activity, status: "live", group: "Payment Management" },
  { href: "/payout-data",      label: "Payout Data",     icon: Activity, status: "live", group: "Payment Management" },
  { href: "/channels",         label: "Channels",        icon: Network,  status: "live", group: "Payment Management" },

  { href: "/ledger", label: "Ledger", icon: BookOpen, status: "live", group: "Money Movement" },
  { href: "/payout", label: "Payouts (gRPC)", icon: Send, status: "live", group: "Money Movement" },
  { href: "/settlement", label: "Settlements", icon: Banknote, status: "live", group: "Money Movement" },
  { href: "/branch-settlements", label: "Banker Settlements", icon: Banknote, status: "live", group: "Money Movement" },
  { href: "/settlement-engine", label: "Settlement Engine", icon: Banknote, status: "live", group: "Money Movement", personas: ["SUPER_ADMIN", "ADMIN", "OPERATOR", "FINANCE", "COMPLIANCE"] },
  { href: "/collections", label: "Collections", icon: Inbox, status: "live", group: "Money Movement" },
  { href: "/checkout", label: "Checkout", icon: CreditCard, status: "live", group: "Money Movement" },
  { href: "/routing", label: "Routing Engine", icon: Workflow, status: "live", group: "Money Movement" },
  { href: "/pg-adapter", label: "PG Adapters", icon: Network, status: "live", group: "Money Movement" },
  { href: "/bank-adapter", label: "Bank Adapters", icon: Network, status: "live", group: "Money Movement" },
  { href: "/crypto-rail", label: "Crypto Rails", icon: Coins, status: "live", group: "Money Movement" },
  { href: "/vendors/katana", label: "Katana Pay", icon: CreditCard, status: "live", group: "Money Movement" },
  // Each banker's pay-in traffic between its own MIDs (lib/mid-switch).
  { href: "/mid-switch", label: "MID switch", icon: ArrowRightLeft, status: "live", group: "Money Movement" },
  // Display name only — the rail code stays QUICKPAY in the DB, adapters and routes.
  { href: "/vendors/quickpay", label: "Vendor PG", icon: CreditCard, status: "live", group: "Money Movement" },

  { href: "/partner-data", label: "Partner Data", icon: GitMerge, status: "live", group: "Money Movement" },
  { href: "/reserves", label: "Reserves", icon: BookOpen, status: "live", group: "Money Movement" },

  { href: "/dt-dashboard", label: "DT Dashboard", icon: Coins, status: "live", group: "DT Business", personas: ["SUPER_ADMIN", "ADMIN", "FINANCE"] },
  { href: "/dt-purchases", label: "DT Purchases", icon: Receipt, status: "live", group: "DT Business", personas: ["SUPER_ADMIN", "ADMIN", "FINANCE"] },
  { href: "/dt-refills", label: "DT Refills", icon: Droplets, status: "live", group: "DT Business", personas: ["SUPER_ADMIN", "ADMIN", "FINANCE"] },

  { href: "/reconciliation", label: "Reconciliation", icon: GitMerge, status: "live", group: "Risk & Compliance" },
  { href: "/risk", label: "Risk & Velocity", icon: ShieldAlert, status: "live", group: "Risk & Compliance" },
  { href: "/risk/aml", label: "AML / Sanctions", icon: ShieldAlert, status: "live", group: "Risk & Compliance" },
  { href: "/risk/payin-flags", label: "Pay-in flags", icon: ShieldAlert, status: "live", group: "Risk & Compliance" },
  { href: "/disputes", label: "Disputes", icon: ShieldAlert, status: "live", group: "Risk & Compliance" },
  // Banker-side chargebacks on Katana Pay pay-ins (lib/chargebacks-store); rules on its Rules tab.
  { href: "/chargebacks", label: "Chargebacks", icon: ShieldAlert, status: "live", group: "Risk & Compliance" },
  { href: "/kyb", label: "KYB", icon: FileCheck2, status: "live", group: "Risk & Compliance" },
  { href: "/forensics", label: "Forensics", icon: FileSearch, status: "live", group: "Risk & Compliance" },
  { href: "/cases", label: "Compliance Cases", icon: Briefcase, status: "live", group: "Risk & Compliance" },

  { href: "/operator", label: "Operator Console", icon: Headphones, status: "live", group: "Operations", personas: OPERATOR_NAV },
  // Staff test it here; merchants and bankers use it from their portals once SUPPORT_BOT_PORTALS is on (lib/support-bot).
  { href: "/support-bot", label: "Support assistant", icon: Bot, status: "live", group: "Operations", personas: ["SUPER_ADMIN", "ADMIN", "SUPPORT"] },
  { href: "/payouts", label: "Payouts & Beneficiaries", icon: Send, status: "live", group: "Operations" },
  { href: "/status-intelligence", label: "Status Intelligence", icon: Activity, status: "live", group: "Operations" },
  { href: "/transaction-intel", label: "Transaction Intel", icon: ShieldAlert, status: "live", group: "Operations" },
  { href: "/fifo-dashboard", label: "FIFO Dashboard", icon: LayoutDashboard, status: "live", group: "Operations" },
  { href: "/fifo-reports", label: "FIFO Reports", icon: BarChart3, status: "live", group: "Operations" },
  { href: "/fifo-reconciliation", label: "FIFO Reconciliation", icon: GitMerge, status: "live", group: "Operations" },
  { href: "/fifo-settlements", label: "FIFO Settlements", icon: Banknote, status: "live", group: "Operations" },
  { href: "/agents", label: "Agents & Franchise", icon: Users, status: "live", group: "Operations" },
  { href: "/p2p", label: "P2P Traders", icon: Users, status: "live", group: "Operations" },
  { href: "/commission", label: "Commission", icon: Percent, status: "live", group: "Operations" },
  { href: "/events", label: "Event stream", icon: Activity, status: "live", group: "Operations" },
  { href: "/reporting", label: "Reporting", icon: BarChart3, status: "read-only", group: "Operations" },
  { href: "/tenants", label: "Tenants", icon: Globe, status: "live", group: "Operations" },

  { href: "/admin/users",          label: "Users",        icon: UserCog,  status: "live", group: "Admin" },
  { href: "/admin/mailboxes",      label: "Mailboxes",    icon: KeyRound, status: "live", group: "Admin" },
  { href: "/admin/roles",          label: "Roles & Permissions", icon: Shield, status: "live", group: "Admin" },
  { href: "/admin/api-keys",       label: "API Keys",     icon: KeyRound, status: "live", group: "Admin" },
  { href: "/admin/assignments",    label: "Assignments",  icon: UserPlus, status: "live", group: "Admin" },
  { href: "/admin/access",         label: "Access matrix", icon: Shield,   status: "live", group: "Admin" },
  { href: "/admin/maker-checker",  label: "Maker-Checker", icon: ShieldAlert, status: "live", group: "Admin" },
  { href: "/admin/webhooks",       label: "Webhooks", icon: Workflow, status: "live", group: "Admin" },
  { href: "/admin/routing",        label: "Routing cockpit", icon: GitMerge, status: "live", group: "Admin" },
  { href: "/admin/tokens",         label: "Vault & tokens", icon: KeyRound, status: "live", group: "Admin" },
  { href: "/admin/noc",            label: "NOC cockpit", icon: Activity, status: "live", group: "Admin" },
  { href: "/admin/refunds",        label: "Refunds", icon: Banknote, status: "live", group: "Admin" },
  { href: "/admin/ai-ops",         label: "AI Ops", icon: Users, status: "live", group: "Admin" },
  { href: "/admin/hardening",      label: "Hardening", icon: Shield, status: "live", group: "Admin" },
  { href: "/integrations",         label: "Integrations", icon: KeyRound, status: "live", group: "Admin" },
  { href: "/partner-inquiries",     label: "Partner Inquiries", icon: Headphones, status: "live", group: "Admin", personas: ["SUPER_ADMIN", "ADMIN", "SUPPORT"] },
  { href: "/live-activations",     label: "Live activations", icon: Rocket, status: "live", group: "Admin", personas: ["SUPER_ADMIN"] },
  { href: "/security",             label: "Security (MFA)", icon: Shield, status: "live", group: "Admin", personas: ["SUPER_ADMIN", "PROVIDER", "MERCHANT", "OPERATOR"] },
  { href: "/fifo-controls",        label: "Banker Controls", icon: Sliders, status: "live", group: "Admin" },
];

export const navGroups = ["Overview", "Provider Management", "Payment Management", "Money Movement", "DT Business", "Risk & Compliance", "Operations", "Admin"] as const;
