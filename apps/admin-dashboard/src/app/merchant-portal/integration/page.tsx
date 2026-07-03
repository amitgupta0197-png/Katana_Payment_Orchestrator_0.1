"use client";

// BRANCH developer integration page. Hands the merchant everything a website in
// ANY language needs: the orchestrator endpoint URLs, their checkout Key (+ Salt
// regenerate), the request signing spec, a copy-paste cURL sample, and how to
// verify the status callback we POST back. Return/webhook URLs are set in Profile.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { Plug, Copy, KeyRound, RefreshCw, Check, ExternalLink, Webhook } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface Integration {
  merchant_code: string;
  credentials: { configured: boolean; key?: string; scheme?: string; salt_hint?: string };
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

export default function IntegrationPage() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["me-integration"],
    queryFn: async () => (await fetch("/api/me/integration").then(async (r) => { const d = await r.json().catch(() => null); if (!r.ok) throw new Error((d && d.error) || "HTTP " + r.status); return d; })) as Integration,
  });
  const [regenOpen, setRegenOpen] = useState(false);
  const [newCreds, setNewCreds] = useState<{ key: string; salt: string; scheme: string } | null>(null);

  const d = q.data;
  const key = d?.credentials?.key ?? "<your key>";
  const ep = d?.endpoints;
  const scheme = d?.credentials?.scheme ?? "HMAC_SHA256";

  const regen = useMutation({
    mutationFn: async (sch: string) => {
      const r = await fetch("/api/me/integration", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scheme: sch }) });
      const dd = await r.json().catch(() => ({})); if (!r.ok) throw new Error(dd.error ?? "Failed"); return dd.creds as { key: string; salt: string; scheme: string };
    },
    onSuccess: (creds) => { setNewCreds(creds); setRegenOpen(false); qc.invalidateQueries({ queryKey: ["me-integration"] }); },
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
    ? `// PAYU_SHA512
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
        actions={<Button asChild size="sm" variant="secondary"><a href="/katana-pay-integration.html" target="_blank" rel="noopener"><ExternalLink className="h-4 w-4" /> Open setup guide</a></Button>} />

      {/* Credentials */}
      <Card className="mb-4">
        <CardHeader className="flex flex-row items-center justify-between">
          <div><CardTitle className="text-base inline-flex items-center gap-2"><KeyRound className="h-4 w-4" />Your credentials</CardTitle>
            <CardDescription>The Key goes in every request; the Salt signs the hash and is shown only once.</CardDescription></div>
          <Button size="sm" variant="secondary" onClick={() => setRegenOpen(true)}><RefreshCw className="h-4 w-4" />{d?.credentials?.configured ? "Regenerate" : "Generate"} Key + Salt</Button>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {q.isLoading ? "Loading…" : d?.credentials?.configured ? (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <div className="space-y-1"><div className="text-xs text-[color:var(--color-text-muted)]">Key</div><Copyable value={d.credentials.key!} /></div>
              <div className="space-y-1"><div className="text-xs text-[color:var(--color-text-muted)]">Scheme</div><Badge variant="brand">{d.credentials.scheme}</Badge></div>
              <div className="space-y-1"><div className="text-xs text-[color:var(--color-text-muted)]">Salt</div><span className="font-mono text-xs">{d.credentials.salt_hint}</span></div>
            </div>
          ) : <p className="text-[color:var(--color-text-muted)]">No credentials yet — click <b>Generate Key + Salt</b>.</p>}
        </CardContent>
      </Card>

      {/* Endpoints */}
      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base">Endpoints</CardTitle><CardDescription>Same for every language. IP-whitelisting required for production server-to-server calls.</CardDescription></CardHeader>
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
          <Button asChild size="sm" variant="secondary"><Link href="/merchant-portal/profile">Edit in Profile <ExternalLink className="h-3.5 w-3.5" /></Link></Button>
        </CardContent>
      </Card>

      {/* Regenerate dialog */}
      <Dialog open={regenOpen} onOpenChange={setRegenOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Generate Key + Salt</DialogTitle><DialogDescription>This replaces any existing credentials. The Salt is shown only once — copy it now.</DialogDescription></DialogHeader>
          <div className="flex gap-2">
            {(d?.schemes ?? ["HMAC_SHA256", "PAYU_SHA512"]).map((s) => (
              <Button key={s} variant="secondary" disabled={regen.isPending} onClick={() => regen.mutate(s)}>{s}</Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!newCreds} onOpenChange={(o) => !o && setNewCreds(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Save these now</DialogTitle><DialogDescription>The Salt will never be shown again.</DialogDescription></DialogHeader>
          {newCreds && (
            <div className="space-y-2 text-sm">
              <div><div className="text-xs text-[color:var(--color-text-muted)]">Key</div><Copyable value={newCreds.key} /></div>
              <div><div className="text-xs text-[color:var(--color-text-muted)]">Salt</div><Copyable value={newCreds.salt} /></div>
              <div><div className="text-xs text-[color:var(--color-text-muted)]">Scheme</div><Badge variant="brand">{newCreds.scheme}</Badge></div>
            </div>
          )}
          <DialogFooter><Button onClick={() => setNewCreds(null)}>I’ve saved them</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
