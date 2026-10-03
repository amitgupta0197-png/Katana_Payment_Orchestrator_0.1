"use client";

// The merchant portal (PROVIDER persona). Its menu, in a handful of groups; the frame, search and
// phone tab bar are shared with the banker portal (components/portal/portal-frame).

import {
  Store, CreditCard, Percent, FileCheck2, LifeBuoy, Receipt, HelpCircle, Contact, Banknote, Plug, ShieldAlert,
  FileSpreadsheet, GitMerge, Search, Webhook, ScrollText, Sparkles, UserPlus, Wallet, Briefcase, Code2, BarChart3, KeyRound,
} from "lucide-react";
import { PortalFrame, type NavGroup } from "@/components/portal/portal-frame";
import { allowsPayin, type MerchantServicesSetting } from "@/lib/merchant-services";

const B = "/merchant-portal";

// Pages that are about pay-ins only. A merchant onboarded for payouts only (lib/merchant-services)
// takes none, so its portal leaves them out; the pages themselves stay reachable and empty.
const PAYIN_ONLY = new Set([`${B}/orders`, `${B}/reconciliation`, `${B}/chargebacks`, `${B}/sub-mids`]);

const GROUPS: NavGroup[] = [
  { id: "payments", label: "Payments", icon: Receipt, items: [
    { href: `${B}/orders`, label: "Orders", icon: Search },
    { href: `${B}/transactions`, label: "Transactions", icon: Receipt },
    { href: `${B}/reconciliation`, label: "Matching", icon: GitMerge },
    { href: `${B}/statements`, label: "Statements", icon: FileSpreadsheet },
    { href: `${B}/chargebacks`, label: "Chargebacks", icon: ShieldAlert },
    { href: `${B}/reports`, label: "Reports", icon: BarChart3 },
  ] },
  { id: "money", label: "Money", icon: Wallet, items: [
    { href: `${B}/settlements`, label: "Settlements", icon: Banknote },
    { href: `${B}/commission`, label: "Commission", icon: Percent },
  ] },
  { id: "business", label: "Business", icon: Briefcase, items: [
    { href: `${B}/bankers`, label: "Bankers", icon: Store },
    // In the main menu, not behind "Developer tools": issuing a Key + Salt is the first thing a
    // merchant is told to do, and with the switch off by default nobody could find it (2026-10-03).
    { href: `${B}/keys`, label: "Key + Salt", icon: KeyRound },
    { href: `${B}/leads`, label: "Leads", icon: UserPlus },
    { href: `${B}/vendors`, label: "Vendors", icon: Contact },
    { href: `${B}/sub-mids`, label: "Sub-MIDs", icon: CreditCard },
    { href: `${B}/kyc`, label: "Documents (KYC)", icon: FileCheck2 },
  ] },
  { id: "help", label: "Help", icon: HelpCircle, items: [
    { href: `${B}/assistant`, label: "Assistant", icon: Sparkles },
    { href: `${B}/tickets`, label: "Support tickets", icon: LifeBuoy },
    { href: `${B}/help`, label: "Guide", icon: HelpCircle },
  ] },
];

const DEV: NavGroup = { id: "developers", label: "Developers", icon: Code2, items: [
  { href: `${B}/integration`, label: "Integration", icon: Plug },
  { href: `${B}/webhooks`, label: "Webhooks & keys", icon: Webhook },
  { href: `${B}/api-log`, label: "API log", icon: ScrollText },
] };

export function ProviderPortalShell({
  children, scopeLabel, email, fullName, livemode, services = "UNSET", assistant = false,
}: { children: React.ReactNode; scopeLabel: string; email: string; fullName: string; livemode: boolean; services?: MerchantServicesSetting; assistant?: boolean }) {
  // The support assistant is listed once it is open to merchants (lib/support-bot/scope).
  const keep = (href: string) => (allowsPayin(services) || !PAYIN_ONLY.has(href)) && (assistant || !href.endsWith("/assistant"));
  const groups = GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => keep(i.href)) })).filter((g) => g.items.length);
  return (
    <PortalFrame base={B} subtitle="Merchant portal" badge="Merchant" groups={groups} devGroup={DEV}
      paymentsHref={allowsPayin(services) ? `${B}/orders` : `${B}/transactions`} assistant={assistant} floatingAssistant
      scopeLabel={scopeLabel} email={email} fullName={fullName} livemode={livemode}>
      {children}
    </PortalFrame>
  );
}
