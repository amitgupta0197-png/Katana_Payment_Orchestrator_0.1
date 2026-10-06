"use client";

// The banker portal (MERCHANT persona). Its menu, in a handful of groups; the frame, search and
// phone tab bar are shared with the merchant portal (components/portal/portal-frame).

import {
  Receipt, Banknote, BookOpen, CreditCard, KeyRound, ShieldAlert, UserCog, HelpCircle, Landmark, Plug,
  FileSpreadsheet, QrCode, Search, Webhook, ScrollText, Sparkles, Wallet, Settings, Code2, BarChart3, ArrowRightLeft,
  FlaskConical,
} from "lucide-react";
import { PortalFrame, type NavGroup } from "@/components/portal/portal-frame";
import { allowsPayin, type MerchantServicesSetting } from "@/lib/merchant-services";

const B = "/banker-portal";

// Pages that are about pay-ins only. A merchant onboarded for payouts only (lib/merchant-services)
// takes none, so its portal leaves them out; the pages themselves stay reachable and empty.
const PAYIN_ONLY = new Set([`${B}/qr-switch`, `${B}/orders`, `${B}/sub-mids`, `${B}/disputes`, `${B}/mid-switch`]);

const GROUPS: NavGroup[] = [
  { id: "payments", label: "Payments", icon: Receipt, items: [
    { href: `${B}/orders`, label: "Orders", icon: Search },
    { href: `${B}/transactions`, label: "Transactions", icon: Receipt },
    { href: `${B}/statements`, label: "Statements", icon: FileSpreadsheet },
    { href: `${B}/disputes`, label: "Chargebacks", icon: ShieldAlert },
    { href: `${B}/reports`, label: "Reports", icon: BarChart3 },
  ] },
  { id: "money", label: "Money", icon: Wallet, items: [
    { href: `${B}/settlements`, label: "Settlements", icon: Banknote },
    { href: `${B}/provider-settlements`, label: "Settling with your merchant", icon: Landmark },
    { href: `${B}/reserves`, label: "Reserves", icon: BookOpen },
  ] },
  { id: "setup", label: "Setup", icon: Settings, items: [
    { href: `${B}/mid-switch`, label: "MID switch", icon: ArrowRightLeft },
    { href: `${B}/qr-switch`, label: "Payment QR", icon: QrCode },
    { href: `${B}/sub-mids`, label: "Sub-MIDs", icon: CreditCard },
    { href: `${B}/profile`, label: "Profile", icon: UserCog },
  ] },
  { id: "help", label: "Help", icon: HelpCircle, items: [
    { href: `${B}/assistant`, label: "Assistant", icon: Sparkles },
    { href: `${B}/help`, label: "Guide", icon: HelpCircle },
  ] },
];

const DEV: NavGroup = { id: "developers", label: "Developers", icon: Code2, items: [
  { href: `${B}/integration`, label: "Integration", icon: Plug },
  { href: `${B}/api-keys`, label: "API keys", icon: KeyRound },
  { href: `${B}/webhooks`, label: "Webhooks & keys", icon: Webhook },
  { href: `${B}/api-log`, label: "API log", icon: ScrollText },
  { href: `${B}/test-integration`, label: "Test my integration", icon: FlaskConical },
] };

export function MerchantPortalShell({
  children, scopeLabel, email, fullName, livemode, services = "UNSET", assistant = false,
}: { children: React.ReactNode; scopeLabel: string; email: string; fullName: string; livemode: boolean; services?: MerchantServicesSetting; assistant?: boolean }) {
  // The support assistant is listed once it is open to merchants (lib/support-bot/scope).
  const keep = (href: string) => (allowsPayin(services) || !PAYIN_ONLY.has(href)) && (assistant || !href.endsWith("/assistant"));
  const groups = GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => keep(i.href)) })).filter((g) => g.items.length);
  return (
    <PortalFrame base={B} subtitle="Banker portal" badge="Banker" groups={groups} devGroup={DEV}
      paymentsHref={allowsPayin(services) ? `${B}/orders` : `${B}/transactions`} assistant={assistant}
      scopeLabel={scopeLabel} email={email} fullName={fullName} livemode={livemode}>
      {children}
    </PortalFrame>
  );
}
