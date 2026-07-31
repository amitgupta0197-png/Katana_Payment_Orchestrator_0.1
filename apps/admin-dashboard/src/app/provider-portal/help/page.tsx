// Provider help & guide — how to use the provider portal. Static content; mirrors
// PROVIDER-GUIDE.md in the repo's docs/.

import Link from "next/link";
import { HelpCircle, UserPlus, Store, Receipt, CreditCard, Percent, FileCheck2, LifeBuoy, ChevronRight } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[color:var(--color-brand)] text-[10px] font-bold text-white">{n}</span>
      <span className="text-sm">{children}</span>
    </li>
  );
}

export default function ProviderHelpPage() {
  return (
    <>
      <PageHeader title="Help & guide" description="How to use your provider portal — leads, branches, Sub-MIDs, commission, and more." icon={HelpCircle} />

      {/* Quick links */}
      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base">Jump to</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {[
            { href: "/provider-portal/leads", label: "Add a branch lead", icon: UserPlus },
            { href: "/provider-portal/merchants", label: "Your branches", icon: Store },
            { href: "/provider-portal/transactions", label: "Transactions & reimbursement", icon: Receipt },
            { href: "/provider-portal/sub-mids", label: "Request a Sub-MID", icon: CreditCard },
            { href: "/provider-portal/commission", label: "Commission", icon: Percent },
            { href: "/provider-portal/kyc", label: "Your KYC", icon: FileCheck2 },
          ].map((l) => {
            const Icon = l.icon;
            return (
              <Link key={l.href} href={l.href} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm hover:bg-[color:var(--color-surface-muted)]">
                <span className="inline-flex items-center gap-2"><Icon className="h-4 w-4 text-[color:var(--color-brand)]" />{l.label}</span>
                <ChevronRight className="h-4 w-4 text-[color:var(--color-text-muted)]" />
              </Link>
            );
          })}
        </CardContent>
      </Card>

      {/* Signing in */}
      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base">Signing in</CardTitle>
          <CardDescription>Access your portal at the login page.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>Sign in with the <strong>email</strong> and <strong>password</strong> your Katana account manager shared with you. Your portal only shows branches and data <strong>mapped to you</strong>.</p>
        </CardContent>
      </Card>

      {/* Dashboard */}
      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base">Dashboard — your portfolio at a glance</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>The dashboard shows live KPIs: mapped merchants (total / live / onboarding), Sub-MIDs (live + pending KYC), open KYB cases, and your MTD / YTD commission. The <strong>Insights</strong> charts show pay-in volume, status, collected ₹, and channel mix across your branches. The <strong>onboarding funnel</strong> shows where each branch sits across the 6 stages: APPLICATION → DOCS_PENDING → SCREENING → BANK_VERIFY → CONFIG → LIVE.</p>
        </CardContent>
      </Card>

      {/* Leads */}
      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><UserPlus className="h-4 w-4" /> Add a branch lead</CardTitle>
          <CardDescription>Onboard a new branch under your account.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <ol className="space-y-2">
            <Step n={1}>Go to <strong>Leads</strong> → click <strong>New lead</strong>.</Step>
            <Step n={2}>Fill in the merchant&rsquo;s details: code, legal name, brand, business type, contact email &amp; phone, website.</Step>
            <Step n={3}>Submit. The branch is created at the <strong>APPLICATION</strong> stage and auto-mapped to you.</Step>
            <Step n={4}>A <strong>branch login is created automatically</strong> — a one-time password is shown; share it with the merchant so they can sign in to their own portal.</Step>
          </ol>
          <p className="text-xs text-[color:var(--color-text-muted)]">You can only create leads under your own account, and you only see leads you created. From there the branch moves through the onboarding funnel.</p>
        </CardContent>
      </Card>

      {/* Merchants */}
      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><Store className="h-4 w-4" /> Your branches</CardTitle>
          <CardDescription>View the branches mapped to you.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>Open <strong>Branches</strong> to see your approved &amp; live merchants. Click one to view its details, its <strong>Sub-MIDs</strong> (code, mode, KYC, settlement), and its <strong>rolling reserves</strong> (hold amount, release date, status).</p>
          <p className="text-xs text-[color:var(--color-text-muted)]">This view is read-only — branch onboarding starts from <strong>Leads</strong>, and branch edits are made by the branch or Katana.</p>
        </CardContent>
      </Card>

      {/* Transactions */}
      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><Receipt className="h-4 w-4" /> Transactions &amp; reimbursement</CardTitle>
          <CardDescription>Gross collected across your branches.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>Open <strong>Transactions</strong> to see gross value across all channels (Katana Pay, PayU, Cashfree, Razorpay, …) for your mapped branches, broken down <strong>by branch</strong> and <strong>by channel</strong>, plus recent activity.</p>
          <p className="text-xs text-[color:var(--color-text-muted)]"><strong>Gross</strong> counts successful collections only — this is the reimbursable value your commission is based on.</p>
        </CardContent>
      </Card>

      {/* Sub-MIDs */}
      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><CreditCard className="h-4 w-4" /> Request a Sub-MID</CardTitle>
          <CardDescription>Provision a new MID for one of your branches.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <ol className="space-y-2">
            <Step n={1}>Go to <strong>Sub-MIDs</strong> → click <strong>Request Sub-MID</strong>.</Step>
            <Step n={2}>Pick the <strong>branch</strong> (from your mapped branches) and the <strong>Main MID</strong>, enter a <strong>Sub-MID code</strong>, and choose a <strong>mode</strong>.</Step>
            <Step n={3}>Submit. It&rsquo;s created with <Badge variant="warning">PENDING</Badge> KYC and settlement off, then a Katana admin reviews and enables it.</Step>
          </ol>
          <ul className="space-y-1.5 text-xs text-[color:var(--color-text-muted)]">
            <li><Badge variant="info">TRAFFIC</Badge> can start taking traffic right away.</li>
            <li><Badge variant="brand">KYC_APPROVED</Badge> requires the merchant&rsquo;s KYC to be approved first.</li>
            <li>KYC status moves <Badge variant="warning">PENDING</Badge> → <Badge variant="success">APPROVED</Badge>; settlement is enabled separately by Katana.</li>
          </ul>
          <p className="text-xs text-[color:var(--color-text-muted)]">You can only request Sub-MIDs for branches mapped to you.</p>
        </CardContent>
      </Card>

      {/* Commission */}
      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><Percent className="h-4 w-4" /> Commission</CardTitle>
          <CardDescription>Your earnings and rate card.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>Open <strong>Commission</strong> to see your <strong>MTD</strong> and <strong>YTD</strong> earnings and the active <strong>rules</strong> (rate in basis points, fixed fee, validity dates).</p>
          <p className="text-xs text-[color:var(--color-text-muted)]">Rates are set by Katana and are read-only here. Commission accrues on the successful gross shown in Transactions.</p>
        </CardContent>
      </Card>

      {/* KYC */}
      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><FileCheck2 className="h-4 w-4" /> Your KYC</CardTitle>
          <CardDescription>Your onboarding documents &amp; status.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>Open <strong>KYC</strong> to see your provider status and the required document checklist (PAN, GST, CIN, MOA, AOA, board resolution, address proof, bank statement). Statuses follow <Badge variant="warning">PENDING</Badge> → <Badge variant="success">APPROVED</Badge> (or REJECTED / EXPIRED).</p>
          <p className="text-xs text-[color:var(--color-text-muted)]">If document upload isn&rsquo;t available to you yet, send your documents to your Katana account manager.</p>
        </CardContent>
      </Card>

      {/* Support */}
      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><LifeBuoy className="h-4 w-4" /> Support</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          <p>For help, use the <strong>Support</strong> tab or reach the Katana team on the <code>#katana-providers</code> channel / your account manager.</p>
        </CardContent>
      </Card>

      <p className="mb-8 text-center text-xs text-[color:var(--color-text-muted)]">Need more help? Contact your Katana account manager.</p>
    </>
  );
}
