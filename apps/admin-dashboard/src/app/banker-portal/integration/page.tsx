"use client";

// BRANCH developer integration page. Hands the merchant everything a website in
// ANY language needs: the orchestrator endpoint URLs, their checkout Key (+ Salt
// regenerate), the request signing spec, a copy-paste cURL sample, and how to
// verify the status callback we POST back. Return/webhook URLs are set in Profile.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { PinelabsConfigCard } from "@/components/pinelabs-config-card";
import { Plug, Copy, KeyRound, RefreshCw, Check, ExternalLink, Download, Webhook } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface Creds { configured: boolean; key?: string; scheme?: string; salt_hint?: string }

interface Integration {
  merchant_code: string;
  credentials: Creds;          // live pair
  test_credentials?: Creds;    // test pair
  webhook_url: string; return_url: string;
  endpoints: { base_url: string; create_order: string; pay_page: string; status_enquiry: string };
  schemes: string[];
}

function Copyable({ value, mono = true }: { value: string; mono?: boolean }) {
  const [c, setC] = useState(false);
  return (
    <button onClick={() => { navigator.clipboard.writeText(value); setC(true); toast.success("Copied"); setTimeout(() => setC(false), 1200); }}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-left ${mono ? "font-mono text-xs" : "text-sm"} hover:bg-[color:var(--color-surface-muted)]`}>
      <span className="break-all">{value}</span>{c ? <Check className="h-3 w-3 shrink-0 text-[color:var(--color-success)]" /> : <Copy className="h-3 w-3 shrink-0 opacity-60" />}
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

/**
 * What the merchant SEES for a signing scheme. The stored value is unchanged: the kit is
 * white-labelled, so the acquirer whose legacy hash format we reuse must not be named on a
 * merchant-facing screen. Never send this string anywhere — send the raw scheme.
 */
const schemeLabel = (s: string) => (s === "PAYU_SHA512" ? "SHA-512 (legacy)" : s);

export default function IntegrationPage() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["me-integration"],
    queryFn: async () => (await fetch("/api/me/integration").then(async (r) => { const d = await r.json().catch(() => null); if (!r.ok) throw new Error((d && d.error) || "HTTP " + r.status); return d; })) as Integration,
  });
  // Which pair the generate dialog is for: false = test, true = live, null = closed.
  const [regenMode, setRegenMode] = useState<boolean | null>(null);
  const [newCreds, setNewCreds] = useState<{ key: string; salt: string; scheme: string; livemode: boolean } | null>(null);

  const d = q.data;
  // The code samples use the TEST pair when there is one, so copying them while integrating
  // can never create a live order.
  const samplePair = d?.test_credentials?.configured ? d.test_credentials : d?.credentials;
  const key = samplePair?.key ?? "<your key>";
  const ep = d?.endpoints;
  const scheme = samplePair?.scheme ?? "HMAC_SHA256";

  const regen = useMutation({
    mutationFn: async ({ sch, livemode }: { sch: string; livemode: boolean }) => {
      const r = await fetch("/api/me/integration", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scheme: sch, livemode }) });
      const dd = await r.json().catch(() => ({})); if (!r.ok) throw new Error(dd.error ?? "Failed");
      return { ...(dd.creds as { key: string; salt: string; scheme: string }), livemode };
    },
    onSuccess: (creds) => { setNewCreds(creds); setRegenMode(null); qc.invalidateQueries({ queryKey: ["me-integration"] }); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const curl = `curl -X POST ${ep?.create_order ?? ""} \\
  -H "Content-Type: application/json" \\
  -d '{
    "key": "${key}",
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

# Response → { "pay_url": "${ep?.base_url ?? ""}/pay/<id>", ... }
# Redirect the customer's browser to pay_url.`;

  const signing = scheme === "PAYU_SHA512"
    ? `// Legacy SHA-512 format  (your scheme)
hash = SHA512( key + "|" + txnid + "|" + amount + "|" + productinfo + "|" +
               firstname + "|" + email + "|||||||||||" + salt )   // lowercase hex`
    : `// HMAC_SHA256  (your scheme)
data = txnid + "|" + amount + "|" + productinfo + "|" + email
hash = HMAC_SHA256( key=(KEY + SALT), message=data )              // lowercase hex`;

  const callbackVerify = `// We POST JSON to your notify_url / webhook URL on every terminal status:
{ "PAY_ID":"...", "ORDER_ID":"ORDER-1001", "TXN_ID":"...", "AMOUNT":"100",
  "CURRENCY_CODE":"356", "STATUS":"Captured", "RESPONSE_CODE":"000",
  "RRN":"...", "RESPONSE_DATE_TIME":"...", "HASH":"<uppercase sha256>" }

// Verify HASH with YOUR salt (same Key+Salt you sign requests with):
//   1. take every field EXCEPT HASH
//   2. sort keys ascending, join as KEY=value with "~"
//   3. append your SALT to the end of the string
//   4. SHA256(string) -> hex -> UPPERCASE  =>  must equal HASH
// STATUS="Captured" & RESPONSE_CODE="000" => paid. Reply HTTP 200.`;

  return (
    <>
      <PageHeader title="Integration" description="Connect any website to Katana Pay — endpoints, signing, and status callbacks." icon={Plug}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild size="sm" variant="secondary"><a href="/katana-pay-integration.html" target="_blank" rel="noopener"><ExternalLink className="h-4 w-4" /> Open setup guide</a></Button>
            {/* The PDF is the same guide, printed — it is what merchants forward to their own developers. */}
            <Button asChild size="sm" variant="secondary"><a href="/Katana-Pay-Integration-Guide.pdf" target="_blank" rel="noopener"><Download className="h-4 w-4" /> Download PDF</a></Button>
          </div>
        } />

      {/* Pine Labs — pull transactions + RRN from your Pine Labs account */}
      <div className="mb-4"><PinelabsConfigCard endpoint="/api/me/pinelabs" canEdit /></div>

      {/* Credentials — one pair per mode */}
      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base inline-flex items-center gap-2"><KeyRound className="h-4 w-4" />Your credentials</CardTitle>
          <CardDescription>
            Integrate with the test pair: test orders pay a sandbox UPI ID and never move real money. Put the live pair on your server to take real payments. Each Salt is shown only once.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm md:grid-cols-2">
          {([false, true] as const).map((live) => {
            const c = live ? d?.credentials : d?.test_credentials;
            return (
              <div key={live ? "live" : "test"} className="space-y-3 rounded-md border p-3">
                <div className="flex items-center justify-between gap-2">
                  {live
                    ? <Badge variant="success">Live</Badge>
                    : <Badge className="bg-[color:var(--color-testmode-muted)] text-[color:var(--color-testmode-text)]">Test</Badge>}
                  <Button size="sm" variant="secondary" onClick={() => setRegenMode(live)}>
                    <RefreshCw className="h-4 w-4" />{c?.configured ? "Regenerate" : "Generate"}
                  </Button>
                </div>
                {q.isLoading ? <p className="text-[color:var(--color-text-muted)]">Loading…</p> : c?.configured ? (
                  <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                    <div className="space-y-1"><div className="text-xs text-[color:var(--color-text-muted)]">Key</div><Copyable value={c.key!} /></div>
                    <div className="space-y-1"><div className="text-xs text-[color:var(--color-text-muted)]">Scheme</div><Badge variant="brand">{schemeLabel(c.scheme!)}</Badge></div>
                    <div className="space-y-1"><div className="text-xs text-[color:var(--color-text-muted)]">Salt</div><span className="font-mono text-xs">{c.salt_hint}</span></div>
                  </div>
                ) : (
                  <p className="text-[color:var(--color-text-muted)]">
                    {live ? "No live credentials yet." : "No test credentials yet. Generate a test pair to start integrating."}
                  </p>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Endpoints */}
      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base">Endpoints</CardTitle><CardDescription>Same for every language. The Key + Salt is the only credential — keep the Salt server-side.</CardDescription></CardHeader>
        <CardContent className="space-y-2 text-sm">
          {ep && [
            ["Create order (POST)", ep.create_order],
            ["Hosted payment page", ep.pay_page],
            ["Status enquiry (GET)", ep.status_enquiry],
          ].map(([label, url]) => (
            <div key={label} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
              <span className="text-[color:var(--color-text-muted)]">{label}</span><Copyable value={url} />
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">1 · Create the order</CardTitle><CardDescription>Server-side. Returns a pay_url you redirect the customer to.</CardDescription></CardHeader>
          <CardContent><CodeBlock>{curl}</CodeBlock></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">2 · Sign the request (hash)</CardTitle><CardDescription>Compute over your fields with your Key + Salt.</CardDescription></CardHeader>
          <CardContent><CodeBlock>{signing}</CodeBlock></CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader><CardTitle className="text-base">3 · Receive the status callback</CardTitle>
          <CardDescription>We POST the terminal status to your <b>notify_url</b> (per order) or your configured webhook URL. Verify the HASH with your Salt.</CardDescription></CardHeader>
        <CardContent><CodeBlock>{callbackVerify}</CodeBlock></CardContent>
      </Card>

      {/* URL config */}
      <Card className="mt-4">
        <CardHeader><CardTitle className="text-base inline-flex items-center gap-2"><Webhook className="h-4 w-4" />Return & webhook URLs</CardTitle>
          <CardDescription>Defaults used when an order omits return_url / notify_url.</CardDescription></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex items-center justify-between"><span className="text-[color:var(--color-text-muted)]">Return URL</span><span className="font-mono text-xs">{d?.return_url || "— not set —"}</span></div>
          <div className="flex items-center justify-between"><span className="text-[color:var(--color-text-muted)]">Webhook URL</span><span className="font-mono text-xs">{d?.webhook_url || "— not set —"}</span></div>
          <Button asChild size="sm" variant="secondary"><Link href="/banker-portal/profile">Edit in Profile <ExternalLink className="h-3.5 w-3.5" /></Link></Button>
        </CardContent>
      </Card>

      {/* Regenerate dialog */}
      <Dialog open={regenMode !== null} onOpenChange={(o) => !o && setRegenMode(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Generate {regenMode ? "live" : "test"} Key + Salt</DialogTitle>
            <DialogDescription>
              This replaces your {regenMode ? "live" : "test"} credentials; your {regenMode ? "test" : "live"} pair is not affected.
              {regenMode ? " Anything still using the old live Key stops working immediately." : ""} The Salt is shown only once — copy it now.
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            {(d?.schemes ?? ["HMAC_SHA256", "PAYU_SHA512"]).map((s) => (
              <Button key={s} variant="secondary" disabled={regen.isPending || regenMode === null}
                onClick={() => regenMode !== null && regen.mutate({ sch: s, livemode: regenMode })}>{schemeLabel(s)}</Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!newCreds} onOpenChange={(o) => !o && setNewCreds(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Save your {newCreds?.livemode ? "live" : "test"} credentials now</DialogTitle><DialogDescription>The Salt will never be shown again.</DialogDescription></DialogHeader>
          {newCreds && (
            <div className="space-y-2 text-sm">
              <div><div className="text-xs text-[color:var(--color-text-muted)]">Mode</div>
                {newCreds.livemode
                  ? <Badge variant="success">Live</Badge>
                  : <Badge className="bg-[color:var(--color-testmode-muted)] text-[color:var(--color-testmode-text)]">Test</Badge>}
              </div>
              <div><div className="text-xs text-[color:var(--color-text-muted)]">Key</div><Copyable value={newCreds.key} /></div>
              <div><div className="text-xs text-[color:var(--color-text-muted)]">Salt</div><Copyable value={newCreds.salt} /></div>
              <div><div className="text-xs text-[color:var(--color-text-muted)]">Scheme</div><Badge variant="brand">{schemeLabel(newCreds.scheme)}</Badge></div>
            </div>
          )}
          <DialogFooter><Button onClick={() => setNewCreds(null)}>I’ve saved them</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
