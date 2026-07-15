import {
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
  FileSearch,
  Briefcase,
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
  group: "Overview" | "Payment Management" | "Money Movement" | "DT Business" | "Risk & Compliance" | "Operations" | "Admin";
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
  OPERATOR:   ["/", "/operator", "/status-intelligence", "/transaction-intel", "/fifo-dashboard", "/security"],
  FINANCE:    ["/", "/status-intelligence", "/transaction-intel", "/fifo-dashboard", "/payouts", "/fifo-settlements", "/fifo-reconciliation", "/fifo-reports", "/ledger", "/settlement", "/reserves", "/dt-dashboard", "/dt-purchases", "/security"],
  RISK:       ["/", "/status-intelligence", "/transaction-intel", "/fifo-dashboard", "/forensics", "/cases", "/risk", "/risk/aml", "/fifo-reports", "/fifo-controls", "/security"],
  COMPLIANCE: ["/", "/forensics", "/cases", "/kyb", "/disputes", "/risk/aml", "/fifo-controls", "/fifo-reports", "/security"],
  SUPPORT:    ["/", "/payin-data", "/payout-data", "/summary", "/security"],
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

  { href: "/providers",        label: "Providers",       icon: UserPlus, status: "live", group: "Payment Management" },
  { href: "/sub-mids",         label: "Sub-MIDs",        icon: Network,  status: "live", group: "Payment Management" },
  { href: "/merchants",        label: "Branch",          icon: Store,    status: "live", group: "Payment Management" },
  { href: "/merchant-config",  label: "Branch Config",   icon: Sliders,  status: "live", group: "Payment Management" },
  { href: "/transactions",     label: "Transactions",    icon: Receipt,  status: "live", group: "Payment Management" },
  { href: "/payin-order",      label: "Payin Order",     icon: Receipt,  status: "live", group: "Payment Management" },
  { href: "/summary",          label: "Summary",         icon: BarChart3,status: "live", group: "Payment Management" },
  { href: "/payout-order",     label: "Payout Order",    icon: Send,     status: "live", group: "Payment Management" },
  { href: "/merchant-wallet",  label: "Branch Wallet",   icon: Wallet,   status: "live", group: "Payment Management" },
  { href: "/fund",             label: "Fund",            icon: Cash,     status: "live", group: "Payment Management" },
  { href: "/payin-data",       label: "Payin Data",      icon: Activity, status: "live", group: "Payment Management" },
  { href: "/payout-data",      label: "Payout Data",     icon: Activity, status: "live", group: "Payment Management" },
  { href: "/channels",         label: "Channels",        icon: Network,  status: "live", group: "Payment Management" },

  { href: "/ledger", label: "Ledger", icon: BookOpen, status: "live", group: "Money Movement" },
  { href: "/payout", label: "Payouts (gRPC)", icon: Send, status: "live", group: "Money Movement" },
  { href: "/settlement", label: "Settlements", icon: Banknote, status: "live", group: "Money Movement" },
  { href: "/branch-settlements", label: "Branch Settlements", icon: Banknote, status: "live", group: "Money Movement" },
  { href: "/collections", label: "Collections", icon: Inbox, status: "live", group: "Money Movement" },
  { href: "/checkout", label: "Checkout", icon: CreditCard, status: "live", group: "Money Movement" },
  { href: "/routing", label: "Routing Engine", icon: Workflow, status: "live", group: "Money Movement" },
  { href: "/pg-adapter", label: "PG Adapters", icon: Network, status: "live", group: "Money Movement" },
  { href: "/bank-adapter", label: "Bank Adapters", icon: Network, status: "live", group: "Money Movement" },
  { href: "/crypto-rail", label: "Crypto Rails", icon: Coins, status: "live", group: "Money Movement" },
  { href: "/vendors/poolpay", label: "Katana Pay", icon: CreditCard, status: "live", group: "Money Movement" },
  { href: "/vendors/quickpay", label: "Quickpay", icon: CreditCard, status: "live", group: "Money Movement" },

  { href: "/partner-data", label: "Partner Data", icon: GitMerge, status: "live", group: "Money Movement" },
  { href: "/reserves", label: "Reserves", icon: BookOpen, status: "live", group: "Money Movement" },

  { href: "/dt-dashboard", label: "DT Dashboard", icon: Coins, status: "live", group: "DT Business", personas: ["SUPER_ADMIN", "ADMIN", "FINANCE"] },
  { href: "/dt-purchases", label: "DT Purchases", icon: Receipt, status: "live", group: "DT Business", personas: ["SUPER_ADMIN", "ADMIN", "FINANCE"] },

  { href: "/reconciliation", label: "Reconciliation", icon: GitMerge, status: "live", group: "Risk & Compliance" },
  { href: "/risk", label: "Risk & Velocity", icon: ShieldAlert, status: "live", group: "Risk & Compliance" },
  { href: "/risk/aml", label: "AML / Sanctions", icon: ShieldAlert, status: "live", group: "Risk & Compliance" },
  { href: "/disputes", label: "Disputes", icon: ShieldAlert, status: "live", group: "Risk & Compliance" },
  { href: "/kyb", label: "KYB", icon: FileCheck2, status: "live", group: "Risk & Compliance" },
  { href: "/forensics", label: "Forensics", icon: FileSearch, status: "live", group: "Risk & Compliance" },
  { href: "/cases", label: "Compliance Cases", icon: Briefcase, status: "live", group: "Risk & Compliance" },

  { href: "/operator", label: "Operator Console", icon: Headphones, status: "live", group: "Operations", personas: OPERATOR_NAV },
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
  { href: "/security",             label: "Security (MFA)", icon: Shield, status: "live", group: "Admin", personas: ["SUPER_ADMIN", "PROVIDER", "MERCHANT", "OPERATOR"] },
  { href: "/fifo-controls",        label: "Branch Controls", icon: Sliders, status: "live", group: "Admin" },
];

export const navGroups = ["Overview", "Payment Management", "Money Movement", "DT Business", "Risk & Compliance", "Operations", "Admin"] as const;
