"use client";

// Checkout integration credentials (Key + Salt) for a merchant — used by both the
// admin merchant page and the provider's merchant detail page. The merchant (or the
// provider integrating on their behalf) puts these into their server to sign S2S
// pay-in calls to /api/v1/poolpay/order. Backed by /api/merchants/[id]/checkout-key
// (SUPER_ADMIN any; PROVIDER for mapped merchants). The Salt is shown once.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Copy } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";

type CheckoutCredsStatus =
  | { configured: false }
  | { configured: true; key: string; scheme: string; salt_hint: string };

export function MerchantCheckoutKeyCard({ merchantId, merchantCode }: { merchantId: string; merchantCode: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [scheme, setScheme] = useState("PAYU_SHA512");
  const [issued, setIssued] = useState<{ key: string; salt: string; scheme: string } | null>(null);

  const statusQ = useQuery({
    queryKey: ["merchant", merchantId, "checkout-key"],
    queryFn: async () => (await fetch(`/api/merchants/${merchantId}/checkout-key`).then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { status: CheckoutCredsStatus },
  });
  const status = statusQ.data?.status;

  const m = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/merchants/${merchantId}/checkout-key`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheme }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json() as Promise<{ creds: { key: string; salt: string; scheme: string } }>;
    },
    onSuccess: (d) => {
      setIssued(d.creds);
      qc.invalidateQueries({ queryKey: ["merchant", merchantId, "checkout-key"] });
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  function close() {
    setOpen(false);
    setTimeout(() => { setIssued(null); m.reset(); }, 200);
  }
  const copy = (v: string) => { navigator.clipboard?.writeText(v); toast.success("Copied"); };

  return (
    <Card className="mb-4">
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="text-base">Checkout integration (Key + Salt)</CardTitle>
          <CardDescription>Key + Salt to sign S2S pay-in calls to Katana from your own server. The Salt is shown once.</CardDescription>
        </div>
        <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
          <DialogTrigger asChild>
            <Button size="sm" variant={status?.configured ? "secondary" : "default"}>
              <KeyRound className="h-4 w-4" /> {status?.configured ? "Regenerate" : "Generate Key + Salt"}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{status?.configured ? "Regenerate" : "Generate"} checkout Key + Salt</DialogTitle>
              <DialogDescription>
                For <span className="font-mono">{merchantCode}</span>. The Salt is shown once — store it securely. Regenerating invalidates the previous pair.
              </DialogDescription>
            </DialogHeader>
            {issued ? (
              <div className="space-y-3">
                <div className="rounded-md border border-[color:var(--color-success)]/30 bg-[color:var(--color-success-muted)] px-3 py-2 text-xs text-[color:var(--color-success)]">
                  Generated. Copy the Salt now — it won&rsquo;t be shown again.
                </div>
                <div className="space-y-1.5">
                  <Label>Branch Key</Label>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 break-all rounded-md border bg-[color:var(--color-surface)] px-3 py-2 text-xs font-mono">{issued.key}</code>
                    <Button size="sm" variant="secondary" onClick={() => copy(issued.key)}><Copy className="h-4 w-4" /></Button>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>Branch Salt</Label>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 break-all rounded-md border bg-[color:var(--color-surface)] px-3 py-2 text-xs font-mono">{issued.salt}</code>
                    <Button size="sm" variant="secondary" onClick={() => copy(issued.salt)}><Copy className="h-4 w-4" /></Button>
                  </div>
                </div>
                <div className="text-xs text-[color:var(--color-text-muted)]">Scheme: <span className="font-mono">{issued.scheme}</span></div>
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label>Signing scheme</Label>
                <select className="flex h-9 w-full rounded-md border px-3 py-1 text-sm bg-[color:var(--color-surface)]"
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
                  <Button onClick={() => m.mutate()} disabled={m.isPending}>{m.isPending ? "Generating…" : "Generate"}</Button>
                </>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent>
        {status?.configured ? (
          <div className="text-sm space-y-1">
            <div><span className="text-[color:var(--color-text-muted)]">Key:</span> <span className="font-mono">{status.key}</span></div>
            <div><span className="text-[color:var(--color-text-muted)]">Salt:</span> <span className="font-mono">{status.salt_hint}</span> <span className="text-[color:var(--color-text-muted)]">· sealed</span></div>
            <div><span className="text-[color:var(--color-text-muted)]">Scheme:</span> <span className="font-mono">{status.scheme}</span></div>
          </div>
        ) : (
          <div className="rounded-md border px-3 py-2 text-xs text-[color:var(--color-text-muted)]">
            No checkout credentials issued yet. Generate a Key + Salt to start integrating.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
