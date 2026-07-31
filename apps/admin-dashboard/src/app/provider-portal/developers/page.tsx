"use client";

// PROVIDER developer settings. Lets a provider wire Katana Pay into their own website.
// A Katana Pay order settles to a specific BRANCH, so credentials are per-branch: pick a
// branch, generate its Key + Salt, and copy the endpoints/signing/callback docs. Same
// order API and signing as the merchant integration page — this just adds the branch
// selector and inline return/webhook URL editing (providers have no per-branch profile).

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plug, Copy, KeyRound, RefreshCw, Check, ExternalLink, Webhook, Store } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface Integration {
  branch: string | null;
  branches: { code: string; name: string }[];
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

export default function ProviderDevelopersPage() {
  const qc = useQueryClient();
  const [branch, setBranch] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["pp:integration", branch],
    queryFn: async () => (await fetch(`/api/provider-portal/integration${branch ? `?branch=${encodeURIComponent(branch)}` : ""}`).then(async (r) => { const d = await r.json().catch(() => null); if (!r.ok) throw new Error((d && d.error) || "HTTP " + r.status); return d; })) as Integration,
  });
  const [regenOpen, setRegenOpen] = useState(false);
  const [newCreds, setNewCreds] = useState<{ key: string; salt: string; scheme: string } | null>(null);
  const [urlOpen, setUrlOpen] = useState(false);
  const [returnUrl, setReturnUrl] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");

  const d = q.data;
  const activeBranch = branch ?? d?.branch ?? null;
  const key = d?.credentials?.key ?? "<your key>";
  const ep = d?.endpoints;
  const scheme = d?.credentials?.scheme ?? "HMAC_SHA256";

  const regen = useMutation({
    mutationFn: async (sch: string) => {
      const r = await fetch("/api/provider-portal/integration", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "regenerate", branch: activeBranch, scheme: sch }) });
      const dd = await r.json().catch(() => ({})); if (!r.ok) throw new Error(dd.error ?? "Failed"); return dd.creds as { key: string; salt: string; scheme: string };
    },
    onSuccess: (creds) => { setNewCreds(creds); setRegenOpen(false); qc.invalidateQueries({ queryKey: ["pp:integration"] }); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const saveUrls = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/provider-portal/integration", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "urls", branch: activeBranch, return_url: returnUrl, webhook_url: webhookUrl }) });
      const dd = await r.json().catch(() => ({})); if (!r.ok) throw new Error(dd.error ?? "Failed"); return dd;
    },
    onSuccess: () => { setUrlOpen(false); toast.success("URLs saved"); qc.invalidateQueries({ queryKey: ["pp:integration"] }); },
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

  const noBranches = !q.isLoading && (d?.branches?.length ?? 0) === 0;

  return (
    <>
      <PageHeader title="Developers" description="Connect Katana Pay to your own website — API keys, endpoints, signing, and status callbacks." icon={Plug}
        actions={<Button asChild size="sm" variant="secondary"><a href="/katana-pay-integration.html" target="_blank" rel="noopener"><ExternalLink className="h-4 w-4" /> Open setup guide</a></Button>} />

      {noBranches ? (
        <Card><CardContent className="py-10 text-center text-sm text-[color:var(--color-text-muted)]">
          You have no branches mapped yet. A Katana Pay order settles into a branch, so add a branch before generating API credentials.
        </CardContent></Card>
      ) : (
        <>
          {/* Branch selector — credentials are per settling branch */}
          <Card className="mb-4">
            <CardHeader><CardTitle className="text-base inline-flex items-center gap-2"><Store className="h-4 w-4" />Settling branch</CardTitle>
              <CardDescription>Payments made through these credentials collect into this branch&apos;s settlement account. Each branch has its own Key + Salt.</CardDescription></CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {(d?.branches ?? []).map((b) => (
                  <button key={b.code} type="button" onClick={() => setBranch(b.code)}
                    className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${activeBranch === b.code ? "border-[color:var(--color-brand)] bg-[color:var(--color-brand-muted)]/40 font-medium" : "hover:bg-[color:var(--color-surface-muted)]"}`}>
                    {b.name} <span className="font-mono text-[10px] text-[color:var(--color-text-muted)]">{b.code}</span>
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Credentials */}
          <Card className="mb-4">
            <CardHeader className="flex flex-row items-center justify-between">
              <div><CardTitle className="text-base inline-flex items-center gap-2"><KeyRound className="h-4 w-4" />API credentials</CardTitle>
                <CardDescription>The Key goes in every request; the Salt signs the hash and is shown only once.</CardDescription></div>
              <Button size="sm" variant="secondary" disabled={!activeBranch} onClick={() => setRegenOpen(true)}><RefreshCw className="h-4 w-4" />{d?.credentials?.configured ? "Regenerate" : "Generate"} Key + Salt</Button>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {q.isLoading ? "Loading…" : d?.credentials?.configured ? (
                <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                  <div className="space-y-1"><div className="text-xs text-[color:var(--color-text-muted)]">Key</div><Copyable value={d.credentials.key!} /></div>
                  <div className="space-y-1"><div className="text-xs text-[color:var(--color-text-muted)]">Scheme</div><Badge variant="brand">{d.credentials.scheme}</Badge></div>
                  <div className="space-y-1"><div className="text-xs text-[color:var(--color-text-muted)]">Salt</div><span className="font-mono text-xs">{d.credentials.salt_hint}</span></div>
                </div>
              ) : <p className="text-[color:var(--color-text-muted)]">No credentials for this branch yet — click <b>Generate Key + Salt</b>.</p>}
            </CardContent>
          </Card>

          {/* Endpoints */}
          <Card className="mb-4">
            <CardHeader><CardTitle className="text-base">Endpoints</CardTitle><CardDescription>Same for every language. IP-whitelisting required for production server-to-server calls.</CardDescription></CardHeader>
            <CardContent className="space-y-2 text-sm">
              {ep && ([
                ["Create order (POST)", ep.create_order],
                ["Hosted payment page", ep.pay_page],
                ["Status enquiry (GET)", ep.status_enquiry],
              ] as [string, string][]).map(([label, url]) => (
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

          {/* URL config — editable inline for providers */}
          <Card className="mt-4">
            <CardHeader className="flex flex-row items-center justify-between">
              <div><CardTitle className="text-base inline-flex items-center gap-2"><Webhook className="h-4 w-4" />Return &amp; webhook URLs</CardTitle>
                <CardDescription>Defaults for this branch when an order omits return_url / notify_url.</CardDescription></div>
              <Button size="sm" variant="secondary" disabled={!activeBranch} onClick={() => { setReturnUrl(d?.return_url ?? ""); setWebhookUrl(d?.webhook_url ?? ""); setUrlOpen(true); }}>Edit</Button>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex items-center justify-between"><span className="text-[color:var(--color-text-muted)]">Return URL</span><span className="font-mono text-xs">{d?.return_url || "— not set —"}</span></div>
              <div className="flex items-center justify-between"><span className="text-[color:var(--color-text-muted)]">Webhook URL</span><span className="font-mono text-xs">{d?.webhook_url || "— not set —"}</span></div>
            </CardContent>
          </Card>
        </>
      )}

      {/* Regenerate dialog */}
      <Dialog open={regenOpen} onOpenChange={setRegenOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Generate Key + Salt</DialogTitle><DialogDescription>This replaces any existing credentials for <b>{activeBranch}</b>. The Salt is shown only once — copy it now.</DialogDescription></DialogHeader>
          <div className="flex gap-2">
            {(d?.schemes ?? ["HMAC_SHA256", "PAYU_SHA512"]).map((sc) => (
              <Button key={sc} variant="secondary" disabled={regen.isPending} onClick={() => regen.mutate(sc)}>{sc}</Button>
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
          <DialogFooter><Button onClick={() => setNewCreds(null)}>I&apos;ve saved them</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* URL edit dialog */}
      <Dialog open={urlOpen} onOpenChange={setUrlOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Return &amp; webhook URLs</DialogTitle><DialogDescription>Used for <b>{activeBranch}</b> when an order doesn&apos;t specify its own. Leave blank to clear.</DialogDescription></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1"><Label htmlFor="ret">Return URL</Label><Input id="ret" value={returnUrl} onChange={(e) => setReturnUrl(e.target.value)} placeholder="https://your-site.com/payment/return" /></div>
            <div className="space-y-1"><Label htmlFor="wh">Webhook URL</Label><Input id="wh" value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://your-site.com/api/katana/callback" /></div>
          </div>
          <DialogFooter><Button variant="secondary" onClick={() => setUrlOpen(false)}>Cancel</Button><Button disabled={saveUrls.isPending} onClick={() => saveUrls.mutate()}>Save</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
