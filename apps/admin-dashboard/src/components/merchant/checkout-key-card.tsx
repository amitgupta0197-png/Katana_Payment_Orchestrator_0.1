"use client";

// Checkout integration credentials (Key + Salt) for a merchant — used by both the
// admin merchant page and the provider's merchant detail page. The merchant (or the
// provider integrating on their behalf) puts these into their server to sign S2S
// pay-in calls to /api/v1/katana-pay/order. Backed by /api/merchants/[id]/checkout-key
// (SUPER_ADMIN any; PROVIDER for mapped merchants). The Salt is shown once.
//
// One pair per mode: a test pair (mk_test_…) whose orders pay a sandbox UPI ID, and a live
// pair (mk_live_…). Regenerating one never touches the other.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Copy } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

type CheckoutCredsStatus =
  | { configured: false }
  | { configured: true; key: string; scheme: string; salt_hint: string };

const MUTED = "text-[color:var(--color-text-muted)]";

function ModeBadge({ live }: { live: boolean }) {
  return live
    ? <Badge variant="success">Live</Badge>
    : <Badge className="bg-[color:var(--color-testmode-muted)] text-[color:var(--color-testmode-text)]">Test</Badge>;
}

export function MerchantCheckoutKeyCard({ merchantId, merchantCode }: { merchantId: string; merchantCode: string }) {
  const qc = useQueryClient();
  // Which pair the dialog generates: false = test, true = live, null = closed.
  const [mode, setMode] = useState<boolean | null>(null);
  const [scheme, setScheme] = useState("PAYU_SHA512");
  const [issued, setIssued] = useState<{ key: string; salt: string; scheme: string; livemode: boolean } | null>(null);

  const statusQ = useQuery({
    queryKey: ["merchant", merchantId, "checkout-key"],
    queryFn: async () => (await fetch(`/api/merchants/${merchantId}/checkout-key`).then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { status: CheckoutCredsStatus; test_status?: CheckoutCredsStatus },
  });

  const m = useMutation({
    mutationFn: async (livemode: boolean) => {
      const r = await fetch(`/api/merchants/${merchantId}/checkout-key`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheme, livemode }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      const d = await r.json() as { creds: { key: string; salt: string; scheme: string } };
      return { ...d.creds, livemode };
    },
    onSuccess: (creds) => {
      setIssued(creds);
      qc.invalidateQueries({ queryKey: ["merchant", merchantId, "checkout-key"] });
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  function close() {
    setMode(null);
    setTimeout(() => { setIssued(null); m.reset(); }, 200);
  }
  const copy = (v: string) => { navigator.clipboard?.writeText(v); toast.success("Copied"); };
  const current = mode === null ? undefined : mode ? statusQ.data?.status : statusQ.data?.test_status;

  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle className="text-base">Checkout integration (Key + Salt)</CardTitle>
        <CardDescription>
          Key + Salt to sign S2S pay-in calls to Katana. Integrate with the test pair (orders pay a sandbox UPI ID and never move real money), then use the live pair for real payments. Each Salt is shown once.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-2">
        {([false, true] as const).map((live) => {
          const s = live ? statusQ.data?.status : statusQ.data?.test_status;
          return (
            <div key={live ? "live" : "test"} className="space-y-2 rounded-md border p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <ModeBadge live={live} />
                <Button size="sm" variant={s?.configured ? "secondary" : "default"} onClick={() => setMode(live)}>
                  <KeyRound className="h-4 w-4" /> {s?.configured ? "Regenerate" : "Generate"}
                </Button>
              </div>
              {s?.configured ? (
                <div className="space-y-1">
                  <div><span className={MUTED}>Key:</span> <span className="font-mono">{s.key}</span></div>
                  <div><span className={MUTED}>Salt:</span> <span className="font-mono">{s.salt_hint}</span> <span className={MUTED}>· sealed</span></div>
                  <div><span className={MUTED}>Scheme:</span> <span className="font-mono">{s.scheme}</span></div>
                </div>
              ) : (
                <div className={`text-xs ${MUTED}`}>
                  {statusQ.isLoading ? "Loading…" : live ? "No live credentials issued yet." : "No test credentials yet. Generate a test pair to start integrating."}
                </div>
              )}
            </div>
          );
        })}
      </CardContent>

      <Dialog open={mode !== null} onOpenChange={(o) => { if (!o) close(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{current?.configured ? "Regenerate" : "Generate"} {mode ? "live" : "test"} Key + Salt</DialogTitle>
            <DialogDescription>
              For <span className="font-mono">{merchantCode}</span>. The Salt is shown once — store it securely. Regenerating replaces only the {mode ? "live" : "test"} pair{mode ? ", and anything still using the old live Key stops working immediately" : ""}.
            </DialogDescription>
          </DialogHeader>
          {issued ? (
            <div className="space-y-3">
              <div className="rounded-md border border-[color:var(--color-success)]/30 bg-[color:var(--color-success-muted)] px-3 py-2 text-xs text-[color:var(--color-success)]">
                Generated. Copy the Salt now — it won&rsquo;t be shown again.
              </div>
              <div className="flex items-center gap-2 text-xs"><span className={MUTED}>Mode</span><ModeBadge live={issued.livemode} /></div>
              <div className="space-y-1.5">
                <Label>Banker Key</Label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 break-all rounded-md border bg-[color:var(--color-surface)] px-3 py-2 text-xs font-mono">{issued.key}</code>
                  <Button size="sm" variant="secondary" onClick={() => copy(issued.key)}><Copy className="h-4 w-4" /></Button>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Banker Salt</Label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 break-all rounded-md border bg-[color:var(--color-surface)] px-3 py-2 text-xs font-mono">{issued.salt}</code>
                  <Button size="sm" variant="secondary" onClick={() => copy(issued.salt)}><Copy className="h-4 w-4" /></Button>
                </div>
              </div>
              <div className={`text-xs ${MUTED}`}>Scheme: <span className="font-mono">{issued.scheme}</span></div>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="checkout-key-scheme">Signing scheme</Label>
              <select id="checkout-key-scheme" className="flex h-9 w-full rounded-md border px-3 py-1 text-sm bg-[color:var(--color-surface)]"
                value={scheme} onChange={(e) => setScheme(e.target.value)}>
                <option value="PAYU_SHA512">PAYU_SHA512 (PayU-style checkout)</option>
                <option value="HMAC_SHA256">HMAC_SHA256</option>
              </select>
            </div>
          )}
          <DialogFooter>
            {issued ? (
              <Button onClick={close}>Done</Button>
            ) : (
              <>
                <Button variant="secondary" onClick={close}>Cancel</Button>
                <Button onClick={() => mode !== null && m.mutate(mode)} disabled={m.isPending || mode === null}>
                  {m.isPending ? "Generating…" : "Generate"}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
