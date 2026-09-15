"use client";

// TSP webhook link for a merchant — the one callback URL, on the Katana domain, that the
// merchant's payment gateway / TSP posts payment results to. Generated at onboarding from the
// merchant's website. Used by the admin merchant page and the provider's merchant detail
// page. Backed by /api/merchants/[id]/tsp-webhook. The signing secret is shown once.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Webhook, Copy, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";

interface LinkStatus { slug: string; url: string; secret_configured: boolean }

const MUTED = "text-[color:var(--color-text-muted)]";

export function MerchantTspWebhookCard({ merchantId, merchantCode }: { merchantId: string; merchantCode: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [issued, setIssued] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["merchant", merchantId, "tsp-webhook"],
    queryFn: async () => {
      const r = await fetch(`/api/merchants/${merchantId}/tsp-webhook`);
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error((d && d.error) || `HTTP ${r.status}`);
      return d as LinkStatus;
    },
  });
  const link = q.data;

  const m = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/merchants/${merchantId}/tsp-webhook`, { method: "POST" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json() as Promise<LinkStatus & { secret: string }>;
    },
    onSuccess: (d) => {
      setIssued(d.secret);
      qc.invalidateQueries({ queryKey: ["merchant", merchantId, "tsp-webhook"] });
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
          <CardTitle className="text-base">TSP webhook link</CardTitle>
          <CardDescription>Give this link to the merchant&apos;s payment gateway / TSP. They post this merchant&apos;s payment results to it, signed with the secret.</CardDescription>
        </div>
        <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
          <DialogTrigger asChild>
            <Button size="sm" variant={link?.secret_configured ? "secondary" : "default"} disabled={!link}>
              <KeyRound className="h-4 w-4" /> {link?.secret_configured ? "Rotate secret" : "Generate secret"}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{link?.secret_configured ? "Rotate" : "Generate"} webhook secret</DialogTitle>
              <DialogDescription>
                For <span className="font-mono">{merchantCode}</span>. The secret is shown once — share it with the TSP privately. Rotating stops the previous secret immediately.
              </DialogDescription>
            </DialogHeader>
            {issued ? (
              <div className="space-y-3">
                <div className="rounded-md border border-[color:var(--color-success)]/30 bg-[color:var(--color-success-muted)] px-3 py-2 text-xs text-[color:var(--color-success)]">
                  Generated. Copy the secret now — it won&rsquo;t be shown again.
                </div>
                <div className="space-y-1.5">
                  <Label>Webhook secret</Label>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 break-all rounded-md border bg-[color:var(--color-surface)] px-3 py-2 text-xs font-mono">{issued}</code>
                    <Button size="sm" variant="secondary" onClick={() => copy(issued)}><Copy className="h-4 w-4" /></Button>
                  </div>
                </div>
              </div>
            ) : (
              <p className={`text-sm ${MUTED}`}>
                {link?.secret_configured
                  ? "The TSP's current secret will stop working. Callbacks fail until they switch to the new one."
                  : "Creates the secret the TSP uses to sign callbacks to this link."}
              </p>
            )}
            <DialogFooter>
              {issued ? (
                <Button onClick={close}>Done</Button>
              ) : (
                <>
                  <Button variant="secondary" onClick={close}>Cancel</Button>
                  <Button onClick={() => m.mutate()} disabled={m.isPending}>{m.isPending ? "Generating…" : link?.secret_configured ? "Rotate" : "Generate"}</Button>
                </>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {q.isError ? (
          <div className={`rounded-md border px-3 py-2 text-xs ${MUTED}`}>Couldn&apos;t load the webhook link: {(q.error as Error).message}</div>
        ) : !link ? (
          <div className={`rounded-md border px-3 py-2 text-xs ${MUTED}`}>Loading…</div>
        ) : (
          <>
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1.5"><Webhook className="h-3.5 w-3.5" /> Callback URL</Label>
              <div className="flex items-center gap-2">
                <code className="flex-1 break-all rounded-md border bg-[color:var(--color-surface)] px-3 py-2 text-xs font-mono">{link.url}</code>
                <Button size="sm" variant="secondary" onClick={() => copy(link.url)}><Copy className="h-4 w-4" /></Button>
              </div>
            </div>
            <div><span className={MUTED}>Secret:</span> {link.secret_configured ? <span>issued · sealed</span> : <span className="text-[color:var(--color-warning)]">not generated yet — callbacks are rejected until it is</span>}</div>
            <div className={`rounded-md border px-3 py-2 text-xs ${MUTED} space-y-1`}>
              <div><b>POST</b> JSON: <span className="font-mono">order_id</span>, <span className="font-mono">status</span> (SUCCESS | FAILED), optional <span className="font-mono">utr</span>, <span className="font-mono">rrn</span>, <span className="font-mono">provider_txn_id</span>.</div>
              <div>Headers: <span className="font-mono">x-timestamp</span> (unix seconds) and <span className="font-mono">x-signature</span> = HMAC-SHA256(secret, sha256(key-sorted JSON) + &quot;.&quot; + timestamp).</div>
              <div>Only this merchant&apos;s orders can be confirmed through this link.</div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
