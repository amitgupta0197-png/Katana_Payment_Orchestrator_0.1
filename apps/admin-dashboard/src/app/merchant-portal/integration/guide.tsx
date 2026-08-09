"use client";

// Client half of the merchant integration guide — everything here is static text;
// the interactivity is only copy-to-clipboard, which is why the page itself stays
// a server component.

import { useState } from "react";
import { Plug, Copy, Check, ExternalLink, Webhook, KeyRound, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

function Copyable({ value }: { value: string }) {
  const [c, setC] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(value); setC(true); toast.success("Copied"); setTimeout(() => setC(false), 1200); }}
      className="inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-left font-mono text-xs hover:bg-[color:var(--color-surface-muted)]">
      <span className="break-all">{value}</span>
      {c ? <Check className="h-3 w-3 shrink-0 text-[color:var(--color-success)]" /> : <Copy className="h-3 w-3 shrink-0 opacity-60" />}
    </button>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-md border bg-[color:var(--color-surface-muted)] p-3 text-xs leading-relaxed"><code>{children}</code></pre>
      <button onClick={() => { navigator.clipboard.writeText(children); toast.success("Copied"); }}
        className="absolute right-2 top-2 rounded-md border bg-[color:var(--color-surface)] p-1 opacity-70 hover:opacity-100"><Copy className="h-3 w-3" /></button>
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[color:var(--color-brand)] text-[10px] font-bold text-white">{n}</span>
      <span className="text-sm">{children}</span>
    </li>
  );
}

export function IntegrationGuide({ base }: { base: string }) {
  const createOrder = `${base}/api/v1/katana-pay/order`;
  const payPage = `${base}/pay/{order_id}`;
  const statusEnquiry = `${base}/api/pay-status/{order_id}`;
  const payuWebhook = `${base}/api/gateway/payu/webhook`;

  const curl = `curl -X POST ${createOrder} \\
  -H "Content-Type: application/json" \\
  -d '{
    "key": "<your key>",
    "txnid": "ORDER-1001",
    "amount": "100.00",
    "productinfo": "Order 1001",
    "firstname": "David",
    "email": "david@example.com",
    "phone": "9998887777",
    "hash": "<computed: see signing>",
    "return_url": "https://your-site.com/payment/return",
    "notify_url": "https://your-site.com/api/katana/callback"
  }'

# Response → { "pay_url": "${base}/pay/<id>", ... }
# Redirect the customer's browser to pay_url.`;

  const signing = `// HMAC_SHA256  (recommended)
message = txnid + "|" + amount + "|" + productinfo + "|" + email
hash    = HMAC_SHA256( key = KEY + SALT, message )        // lowercase hex

// PAYU_SHA512
seq  = KEY + "|" + txnid + "|" + amount + "|" + productinfo + "|" +
       firstname + "|" + email + "|||||||||||" + SALT     // 5 udf + 5 reserved blanks
hash = SHA512(seq)                                        // lowercase hex`;

  const callbackVerify = `// We POST JSON to your notify_url (per order) or your saved webhook URL
// on every terminal status:
{ "PAY_ID":"...", "ORDER_ID":"ORDER-1001", "TXN_ID":"...", "AMOUNT":"100",
  "CURRENCY_CODE":"356", "STATUS":"Captured", "RESPONSE_CODE":"000",
  "RRN":"123456789012", "RESPONSE_DATE_TIME":"...", "HASH":"<uppercase sha256>" }

// Verify HASH with your Salt:
//   1. take every field EXCEPT HASH
//   2. sort keys ascending, join as KEY=value with "~"
//   3. append your SALT to the end of the string
//   4. SHA256(string) -> hex -> UPPERCASE  =>  must equal HASH
// STATUS="Captured" & RESPONSE_CODE="000" => paid. Reply HTTP 200.`;

  return (
    <>
      <PageHeader title="Integration" description="Connect any website to Katana Pay — endpoints, signing, PayU webhook, and status callbacks." icon={Plug}
        actions={<Button asChild size="sm" variant="secondary"><a href="/katana-pay-integration.html" target="_blank" rel="noopener"><ExternalLink className="h-4 w-4" /> Open full guide</a></Button>} />

      {/* How it works */}
      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base">How a payment flows</CardTitle>
          <CardDescription>Works from any language — the only requirement is that your server can POST JSON and compute a hash.</CardDescription></CardHeader>
        <CardContent>
          <ol className="space-y-2">
            <Step n={1}>Your server creates a <b>signed order</b> and gets back a <code className="text-xs">pay_url</code>.</Step>
            <Step n={2}>You <b>redirect the customer</b> to that hosted payment page.</Step>
            <Step n={3}>The customer pays by UPI.</Step>
            <Step n={4}>We <b>POST a signed status callback</b> to your server, and send the customer back to your <code className="text-xs">return_url</code>.</Step>
          </ol>
          <p className="mt-3 text-sm text-[color:var(--color-text-muted)]">
            Always confirm server-side before fulfilling an order. The browser redirect is informational — a customer who closes the tab never triggers it.
          </p>
        </CardContent>
      </Card>

      {/* Credentials — read-only pointer, PROVIDER has no self-serve issue */}
      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base inline-flex items-center gap-2"><KeyRound className="h-4 w-4" />Credentials (Key + Salt)</CardTitle>
          <CardDescription>Every request carries the Key; the Salt signs it and verifies our callbacks.</CardDescription></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>Key + Salt are issued <b>per banker</b>, in that banker&apos;s own portal under <b>Integration → Generate Key + Salt</b>. If you need a pair for an account you manage, ask your Katana account manager.</p>
          <p className="text-[color:var(--color-text-muted)]">The Salt is shown <b>once</b> at issue and is never displayed again. Keep it server-side only — never in browser or app code. Regenerating invalidates the old pair immediately.</p>
        </CardContent>
      </Card>

      {/* Endpoints */}
      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base">Endpoints</CardTitle>
          <CardDescription>Same for every language. Production server-to-server calls require IP whitelisting.</CardDescription></CardHeader>
        <CardContent className="space-y-2 text-sm">
          {[["Create order (POST)", createOrder], ["Hosted payment page", payPage], ["Status enquiry (GET)", statusEnquiry]].map(([label, url]) => (
            <div key={label} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
              <span className="text-[color:var(--color-text-muted)]">{label}</span><Copyable value={url} />
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">1 · Create the order</CardTitle>
            <CardDescription>Server-side. Idempotent on your <code className="text-xs">txnid</code>.</CardDescription></CardHeader>
          <CardContent><CodeBlock>{curl}</CodeBlock></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">2 · Sign the request</CardTitle>
            <CardDescription>Use whichever scheme your Key was issued with.</CardDescription></CardHeader>
          <CardContent><CodeBlock>{signing}</CodeBlock></CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader><CardTitle className="text-base">3 · Receive the status callback</CardTitle>
          <CardDescription>Verify the HASH with your Salt before you trust it, then reply HTTP 200.</CardDescription></CardHeader>
        <CardContent><CodeBlock>{callbackVerify}</CodeBlock></CardContent>
      </Card>

      {/* PayU webhook */}
      <Card className="mt-4">
        <CardHeader><CardTitle className="text-base inline-flex items-center gap-2"><Webhook className="h-4 w-4" />Connect your PayU account</CardTitle>
          <CardDescription>Only if payments route through your own PayU MID. One URL serves every account — do not create one per merchant.</CardDescription></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="space-y-1">
            <div className="text-xs text-[color:var(--color-text-muted)]">Webhook URL — paste into PayU Dashboard → Webhooks</div>
            <Copyable value={payuWebhook} />
          </div>
          <ol className="space-y-2">
            <Step n={1}>Make sure your PayU <b>Key + Salt</b> are stored in Katana first — we verify PayU&apos;s reply hash with them. Without them a payment can never be marked successful.</Step>
            <Step n={2}>In PayU Dashboard → <b>Webhooks</b> → Add webhook, paste the URL above. <b>Type:</b> Payments · <b>Event:</b> Successful (add Failed too if you want failures recorded) · <b>Method:</b> POST.</Step>
            <Step n={3}>Hit <b>Test</b> — we answer 200 on the dashboard&apos;s GET, so the check passes.</Step>
          </ol>
          <p className="text-[color:var(--color-text-muted)]">
            You never configure surl/furl — Katana sets those per transaction automatically.
          </p>
          <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface-muted)] p-3">
            <div className="mb-1 inline-flex items-center gap-2 font-medium"><ShieldCheck className="h-4 w-4 text-[color:var(--color-success)]" />Three layers confirm every payment</div>
            <ul className="ml-1 space-y-1 text-[color:var(--color-text-muted)]">
              <li>· <b>Webhook</b> — fires even if the customer closes the tab. Most reliable.</li>
              <li>· <b>Browser return</b> — only if the customer comes back from their UPI app.</li>
              <li>· <b>Reconciler</b> — sweeps every 15s and asks PayU directly about anything still pending, so a lost callback self-heals.</li>
            </ul>
          </div>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader><CardTitle className="text-base">Go-live checklist</CardTitle></CardHeader>
        <CardContent>
          <ul className="space-y-1.5 text-sm">
            <li>· Key + Salt issued, Salt stored server-side only.</li>
            <li>· Default <b>return_url</b> and <b>webhook URL</b> saved (or passed per order).</li>
            <li>· Server&apos;s public IP sent to Katana for whitelisting.</li>
            <li>· PayU webhook URL pasted into the PayU dashboard, if you use your own MID.</li>
            <li>· Test payment made — callback received and <b>HASH verified</b>.</li>
            <li>· Callbacks handled <b>idempotently</b> — the same ORDER_ID may arrive more than once.</li>
          </ul>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Badge variant="brand">Full reference</Badge>
            <a className="text-sm underline" href="/katana-pay-integration.html" target="_blank" rel="noopener">
              katana-pay-integration.html — request fields, error codes, PHP / Node / Python samples
            </a>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
