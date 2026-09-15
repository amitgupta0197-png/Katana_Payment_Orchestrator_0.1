"use client";

// TSP webhook link for a merchant — the one callback URL, on the Katana domain, that the
// merchant's payment gateway / TSP posts payment results to. Generated at onboarding from the
// merchant's website. Used by the admin merchant page and the provider's merchant detail
// page. Backed by /api/merchants/[id]/tsp-webhook.
//
// One link, a secret per mode: callbacks signed with the test secret can only confirm test
// orders, and the live secret only live orders. Each secret is shown once.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Webhook, Copy, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

interface LinkStatus { slug: string; url: string; secret_configured: boolean; test_secret_configured?: boolean }

const MUTED = "text-[color:var(--color-text-muted)]";

function ModeBadge({ live }: { live: boolean }) {
  return live
    ? <Badge variant="success">Live</Badge>
    : <Badge className="bg-[color:var(--color-testmode-muted)] text-[color:var(--color-testmode-text)]">Test</Badge>;
}

export function MerchantTspWebhookCard({ merchantId, merchantCode }: { merchantId: string; merchantCode: string }) {
  const qc = useQueryClient();
  // Which secret the dialog rotates: false = test, true = live, null = closed.
  const [mode, setMode] = useState<boolean | null>(null);
  const [issued, setIssued] = useState<{ secret: string; livemode: boolean } | null>(null);

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
    mutationFn: async (livemode: boolean) => {
      const r = await fetch(`/api/merchants/${merchantId}/tsp-webhook`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ livemode }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      const d = await r.json() as LinkStatus & { secret: string };
      return { secret: d.secret, livemode };
    },
    onSuccess: (d) => {
      setIssued(d);
      qc.invalidateQueries({ queryKey: ["merchant", merchantId, "tsp-webhook"] });
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  function close() {
    setMode(null);
    setTimeout(() => { setIssued(null); m.reset(); }, 200);
  }
  const copy = (v: string) => { navigator.clipboard?.writeText(v); toast.success("Copied"); };
  const configured = (live: boolean) => (live ? link?.secret_configured : link?.test_secret_configured) === true;

  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle className="text-base">TSP webhook link</CardTitle>
        <CardDescription>Give this link to the merchant&apos;s payment gateway / TSP. They post this merchant&apos;s payment results to it, signed with the test or live secret.</CardDescription>
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
            <div className="grid gap-2 sm:grid-cols-2">
              {([false, true] as const).map((live) => (
                <div key={live ? "live" : "test"} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <ModeBadge live={live} />
                    <span className={`truncate text-xs ${configured(live) ? "" : "text-[color:var(--color-warning)]"}`}>
                      {configured(live) ? "Secret issued · sealed" : "No secret yet"}
                    </span>
                  </div>
                  <Button size="sm" variant={configured(live) ? "secondary" : "default"} onClick={() => setMode(live)}>
                    <KeyRound className="h-4 w-4" /> {configured(live) ? "Rotate" : "Generate"}
                  </Button>
                </div>
              ))}
            </div>
            <div className={`rounded-md border px-3 py-2 text-xs ${MUTED} space-y-1`}>
              <div><b>POST</b> JSON: <span className="font-mono">order_id</span>, <span className="font-mono">status</span> (SUCCESS | FAILED), optional <span className="font-mono">utr</span>, <span className="font-mono">rrn</span>, <span className="font-mono">provider_txn_id</span>.</div>
              <div>Headers: <span className="font-mono">x-timestamp</span> (unix seconds) and <span className="font-mono">x-signature</span> = HMAC-SHA256(secret, sha256(key-sorted JSON) + &quot;.&quot; + timestamp).</div>
              <div>Only this merchant&apos;s orders can be confirmed through this link, and only in the secret&apos;s own mode.</div>
            </div>
          </>
        )}
      </CardContent>

      <Dialog open={mode !== null} onOpenChange={(o) => { if (!o) close(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{mode !== null && configured(mode) ? "Rotate" : "Generate"} {mode ? "live" : "test"} webhook secret</DialogTitle>
            <DialogDescription>
              For <span className="font-mono">{merchantCode}</span>. The secret is shown once — share it with the TSP privately.
              {mode !== null && configured(mode) ? ` Rotating stops the previous ${mode ? "live" : "test"} secret immediately.` : ""}
            </DialogDescription>
          </DialogHeader>
          {issued ? (
            <div className="space-y-3">
              <div className="rounded-md border border-[color:var(--color-success)]/30 bg-[color:var(--color-success-muted)] px-3 py-2 text-xs text-[color:var(--color-success)]">
                Generated. Copy the secret now — it won&rsquo;t be shown again.
              </div>
              <div className="flex items-center gap-2 text-xs"><span className={MUTED}>Mode</span><ModeBadge live={issued.livemode} /></div>
              <div className="space-y-1.5">
                <Label>Webhook secret</Label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 break-all rounded-md border bg-[color:var(--color-surface)] px-3 py-2 text-xs font-mono">{issued.secret}</code>
                  <Button size="sm" variant="secondary" onClick={() => copy(issued.secret)}><Copy className="h-4 w-4" /></Button>
                </div>
              </div>
            </div>
          ) : (
            <p className={`text-sm ${MUTED}`}>
              {mode !== null && configured(mode)
                ? `The TSP's current ${mode ? "live" : "test"} secret will stop working. Its callbacks fail until they switch to the new one.`
                : `Creates the secret the TSP uses to sign ${mode ? "live" : "test"} callbacks to this link.`}
            </p>
          )}
          <DialogFooter>
            {issued ? (
              <Button onClick={close}>Done</Button>
            ) : (
              <>
                <Button variant="secondary" onClick={close}>Cancel</Button>
                <Button onClick={() => mode !== null && m.mutate(mode)} disabled={m.isPending || mode === null}>
                  {m.isPending ? "Generating…" : mode !== null && configured(mode) ? "Rotate" : "Generate"}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
