"use client";

// Client half of the merchant integration guide — everything here is static text;
// the interactivity is only copy-to-clipboard, which is why the page itself stays
// a server component.

import { useState } from "react";
import { Plug, Copy, Check, ExternalLink, Download, KeyRound, ShieldCheck } from "lucide-react";
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

// Legacy SHA-512 format
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
      <PageHeader title="Integration" description="Connect any website to Katana Pay — endpoints, signing, status callbacks, and traceability." icon={Plug}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild size="sm" variant="secondary"><a href="/katana-pay-integration.html" target="_blank" rel="noopener"><ExternalLink className="h-4 w-4" /> Open full guide</a></Button>
            {/* The PDF is the same guide, printed — it is what merchants forward to their own developers. */}
            <Button asChild size="sm" variant="secondary"><a href="/Katana-Pay-Integration-Guide.pdf" target="_blank" rel="noopener"><Download className="h-4 w-4" /> Download PDF</a></Button>
          </div>
        } />

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
          <p>Key + Salt are issued <b>per banker</b>, in that banker&apos;s own portal under <b>Integration</b>. If you need a pair for an account you manage, ask your Katana account manager.</p>
          <p>Each banker has a <b>test pair</b> (<code className="text-xs">mk_test_…</code>) and a <b>live pair</b> (<code className="text-xs">mk_live_…</code>). The Key that signs an order decides its mode: test orders pay a sandbox UPI ID and never move real money. Integrate with the test pair, then swap in the live pair.</p>
          <p className="text-[color:var(--color-text-muted)]">Each Salt is shown <b>once</b> at issue and is never displayed again. Keep it server-side only — never in browser or app code. Regenerating a pair invalidates only that pair, immediately.</p>
        </CardContent>
      </Card>

      {/* Endpoints */}
      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base">Endpoints</CardTitle>
          <CardDescription>Same for every language. The Key + Salt is the only credential — keep the Salt server-side.</CardDescription></CardHeader>
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

      {/* How a payment is confirmed. The acquirer that settles it is deliberately not named —
          this page is merchant-facing and Katana Pay is the brand they integrate against. */}
      <Card className="mt-4">
        <CardHeader><CardTitle className="text-base inline-flex items-center gap-2"><ShieldCheck className="h-4 w-4" />How a payment is confirmed</CardTitle>
          <CardDescription>Three independent layers, so a payment is never lost to a dropped callback.</CardDescription></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <ul className="ml-1 space-y-1 text-[color:var(--color-text-muted)]">
            <li>· <b>Status callback</b> — POSTed to your notify_url on every terminal status, retried until you reply 200. Most reliable.</li>
            <li>· <b>Browser return</b> — only if the customer comes back from their UPI app. Informational; never fulfil on it alone.</li>
            <li>· <b>Reconciler</b> — sweeps anything still pending every 15s, so a lost callback self-heals.</li>
          </ul>
          <p className="text-[color:var(--color-text-muted)]">
            Whatever happens, <b>GET /api/pay-status/&#123;order_id&#125;</b> is the authoritative answer at any moment.
          </p>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader><CardTitle className="text-base">Go-live checklist</CardTitle></CardHeader>
        <CardContent>
          <ul className="space-y-1.5 text-sm">
            <li>· Test integration done with the <b>test pair</b>: Simulate success / failure on the test pay page (or amounts ending .99, .13 and .11) give callbacks that all verify.</li>
            <li>· <b>Live mode activated</b>: the banker completes Integration → Activate live mode and Katana approves it. Live keys stay locked until then.</li>
            <li>· Live Key + Salt issued and swapped in, Salt stored server-side only.</li>
            <li>· Default <b>return_url</b> and <b>webhook URL</b> saved (or passed per order).</li>
            <li>· Small live payment made — callback received and <b>HASH verified</b> with the live Salt.</li>
            <li>· Callbacks handled <b>idempotently</b> — the same ORDER_ID may arrive more than once.</li>
          </ul>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Badge variant="brand">Full reference</Badge>
            <a className="text-sm underline" href="/katana-pay-integration.html" target="_blank" rel="noopener">
              katana-pay-integration.html — request fields, error codes, PHP / Node / Python samples
            </a>
            <span className="text-sm opacity-50">·</span>
            <a className="inline-flex items-center gap-1.5 text-sm underline" href="/Katana-Pay-Integration-Guide.pdf" target="_blank" rel="noopener">
              <Download className="h-3.5 w-3.5" /> Download as PDF
            </a>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
