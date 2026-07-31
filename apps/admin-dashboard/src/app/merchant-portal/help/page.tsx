// Merchant help & guide — how to use the portal's core actions. Static content;
// mirrors MERCHANT-GUIDE.md in the repo root.

import Link from "next/link";
import { HelpCircle, KeyRound, Webhook, CreditCard, Banknote, ChevronRight } from "lucide-react";
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

const codeBlock = "block whitespace-pre overflow-x-auto rounded-md border bg-[color:var(--color-surface-muted)] p-3 text-xs font-mono";

export default function MerchantHelpPage() {
  return (
    <>
      <PageHeader title="Help & guide" description="How to use your branch portal — API keys, webhooks, Sub-MIDs, and settlements." icon={HelpCircle} />

      {/* Quick links */}
      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base">Jump to</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {[
            { href: "/merchant-portal/api-keys", label: "Issue an API key", icon: KeyRound },
            { href: "/merchant-portal/profile", label: "Configure webhooks", icon: Webhook },
            { href: "/merchant-portal/sub-mids", label: "View / request Sub-MIDs", icon: CreditCard },
            { href: "/merchant-portal/settlements", label: "Settlement statements", icon: Banknote },
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
          <p>Sign in with the <strong>email</strong> and <strong>password</strong> your account manager shared with you. Your portal only ever shows <em>your</em> business&rsquo;s data.</p>
          <p>You can change your password anytime under <Link href="/merchant-portal/profile" className="text-[color:var(--color-brand)] underline">Profile → Change password</Link>.</p>
        </CardContent>
      </Card>

      {/* API keys */}
      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><KeyRound className="h-4 w-4" /> Issue an API key</CardTitle>
          <CardDescription>For connecting your systems to Katana&rsquo;s APIs programmatically.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <ol className="space-y-2">
            <Step n={1}>Go to <strong>API keys</strong> in the sidebar and click <strong>Issue key</strong>.</Step>
            <Step n={2}>Give it a <strong>label</strong> (e.g. &ldquo;Production server&rdquo;) and pick the <strong>scopes</strong> it needs.</Step>
            <Step n={3}>Click issue. The <strong>secret</strong> (starts with <code>sk_</code>) is shown <strong>once</strong> — copy and store it securely. We never show it again.</Step>
            <Step n={4}>Use the key in your API calls in the <code>Authorization</code> header.</Step>
          </ol>
          <div>
            <p className="mb-1 font-medium">Scopes</p>
            <div className="flex flex-wrap gap-2">
              <Badge variant="info">payin</Badge><span className="text-xs text-[color:var(--color-text-muted)]">accept payments</span>
              <Badge variant="info">payout</Badge><span className="text-xs text-[color:var(--color-text-muted)]">payouts &amp; settlement</span>
              <Badge variant="info">refund</Badge><span className="text-xs text-[color:var(--color-text-muted)]">issue refunds</span>
              <Badge variant="info">status</Badge><span className="text-xs text-[color:var(--color-text-muted)]">query txn status</span>
            </div>
          </div>
          <code className={codeBlock}>{`Authorization: Bearer sk_your_secret_key_here`}</code>
          <p className="text-xs text-[color:var(--color-text-muted)]">Only a hash of the key is stored. If you lose it, issue a new one and update your integration.</p>
        </CardContent>
      </Card>

      {/* Webhooks */}
      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><Webhook className="h-4 w-4" /> Configure webhooks</CardTitle>
          <CardDescription>Get real-time notifications when a payment&rsquo;s status changes.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <ol className="space-y-2">
            <Step n={1}>Go to <strong>Profile</strong>.</Step>
            <Step n={2}>Enter your <strong>Webhook URL</strong> — it <strong>must be HTTPS</strong> (e.g. <code>https://api.yoursite.com/katana/webhook</code>). Optionally set a <strong>Return URL</strong> for post-payment redirects.</Step>
            <Step n={3}>Click <strong>Save</strong>. Katana will POST a JSON event to that URL whenever an order updates.</Step>
            <Step n={4}>On your endpoint, <strong>verify the signature</strong> and respond <code>200</code>.</Step>
          </ol>
          <div>
            <p className="mb-1 font-medium">Headers we send</p>
            <code className={codeBlock}>{`X-Event-Type:   payment.succeeded
X-Timestamp:    1719660000
X-Payload-Hash: <sha256 of the JSON body>
X-Signature:    <HMAC-SHA256(secret, payloadHash + "." + timestamp)>
X-Attempt:      1`}</code>
          </div>
          <div>
            <p className="mb-1 font-medium">To verify</p>
            <ol className="space-y-2">
              <Step n={1}>Reject if <code>X-Timestamp</code> is more than <strong>±5 minutes</strong> from now (replay protection).</Step>
              <Step n={2}>Compute <code>HMAC-SHA256(your_secret, sha256(body) + "." + timestamp)</code> and compare to <code>X-Signature</code> (timing-safe).</Step>
              <Step n={3}>Return HTTP <code>2xx</code> to acknowledge.</Step>
            </ol>
          </div>
          <p className="text-xs text-[color:var(--color-text-muted)]">
            <strong>Retries:</strong> if your endpoint doesn&rsquo;t return 2xx we retry on a backoff (1m → 5m → 15m → 1h → 6h → 24h). After 6 failures the event is parked in a dead-letter queue. Keep your endpoint fast (&lt; 5s) and idempotent.
          </p>
        </CardContent>
      </Card>

      {/* Sub-MIDs */}
      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><CreditCard className="h-4 w-4" /> Sub-MIDs</CardTitle>
          <CardDescription>The MIDs that route your live traffic.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>Open <strong>Sub-MIDs</strong> to see the MIDs assigned to you, each showing its parent Main MID, mode, KYC status, and whether settlement is enabled.</p>
          <div className="rounded-md border border-[color:var(--color-brand)]/30 bg-[color:var(--color-brand)]/5 p-3 text-xs">
            <strong>Requesting a new Sub-MID:</strong> this is done by your <strong>provider / account manager</strong>, not self-service. Contact them with your expected volume and use-case, and the new Sub-MID will appear here once created.
          </div>
          <ul className="space-y-1.5 text-xs text-[color:var(--color-text-muted)]">
            <li><Badge variant="info">TRAFFIC</Badge> handling live traffic.</li>
            <li><Badge variant="brand">KYC_APPROVED</Badge> KYC cleared.</li>
            <li><strong>KYC status</strong> moves <Badge variant="warning">PENDING</Badge> → <Badge variant="success">APPROVED</Badge>. Settlement is a separate switch that your provider enables.</li>
          </ul>
        </CardContent>
      </Card>

      {/* Settlements */}
      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><Banknote className="h-4 w-4" /> Settlement statements</CardTitle>
          <CardDescription>When your collected money is paid out to your bank.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>Open <strong>Settlements</strong> to see each settlement batch: date, number of transactions, gross, fees, and <strong>net</strong> (what lands in your account).</p>
          <code className={codeBlock}>{`Net payout = Gross collected − Fees − Reserves held`}</code>
          <ul className="space-y-1.5 text-xs text-[color:var(--color-text-muted)]">
            <li><Badge variant="warning">PENDING</Badge> batch created, payout not yet sent.</li>
            <li><Badge variant="success">COMPLETED</Badge> money transferred — the <strong>UTR</strong> (bank reference) and payout reference are filled in.</li>
          </ul>
          <p className="text-xs text-[color:var(--color-text-muted)]">Use the UTR to reconcile the credit against your bank statement.</p>
        </CardContent>
      </Card>

      <p className="mb-8 text-center text-xs text-[color:var(--color-text-muted)]">Need more help? Contact your Katana account manager.</p>
    </>
  );
}
