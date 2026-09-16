"use client";

// PayU Payouts credentials for one merchant: set / rotate them, check they work (live PayU
// balance), and point PayU's payout webhook at Katana. Secrets are write-only here.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, RefreshCw, Webhook } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatAmount, formatDateTime } from "@/lib/utils";

interface PayoutStatus {
  configured: boolean; env?: "TEST" | "PROD"; payout_merchant_id?: string;
  client_id_hint?: string; webhook_registered_at?: string | null;
}
type Balance = { ok: true; balance_minor: string; low_balance: boolean } | { ok: false; error: string };

const EMPTY = { client_id: "", client_secret: "", payout_merchant_id: "", env: "TEST" };

async function readJson(r: Response) {
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
  return d;
}

export function PayuPayoutCard({ merchantId, merchantCode }: { merchantId: string; merchantCode: string }) {
  const qc = useQueryClient();
  const key = ["merchant", merchantId, "payu-payout"];
  const statusQ = useQuery({
    queryKey: key,
    queryFn: async () => {
      const r = await fetch(`/api/merchants/${merchantId}/payu-payout`);
      if (r.status === 403) return { restricted: true as const };
      return (await readJson(r)) as { status: PayoutStatus; webhook_url: string };
    },
  });
  const restricted = (statusQ.data as { restricted?: boolean })?.restricted;
  const status = (statusQ.data as { status?: PayoutStatus })?.status;
  const webhookUrl = (statusQ.data as { webhook_url?: string })?.webhook_url;
  const copyEndpoint = async () => {
    if (!webhookUrl) return;
    try { await navigator.clipboard.writeText(webhookUrl); toast.success("Webhook endpoint copied", { description: webhookUrl }); }
    catch { toast.error("Couldn't copy", { description: webhookUrl }); }
  };

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [balance, setBalance] = useState<Balance | null>(null);

  const save = useMutation({
    mutationFn: async () => readJson(await fetch(`/api/merchants/${merchantId}/payu-payout`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form),
    })),
    onSuccess: () => {
      toast.success("PayU payout credentials saved");
      setOpen(false); setForm(EMPTY); setBalance(null);
      qc.invalidateQueries({ queryKey: key });
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });
  const check = useMutation({
    mutationFn: async () => (await readJson(await fetch(`/api/merchants/${merchantId}/payu-payout?balance=1`))).balance as Balance,
    onSuccess: (b) => { setBalance(b); if (!b.ok) toast.error("PayU didn't answer", { description: b.error }); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });
  const register = useMutation({
    mutationFn: async () => readJson(await fetch(`/api/merchants/${merchantId}/payu-payout?action=register-webhook`, { method: "POST" })),
    onSuccess: (d) => { toast.success("PayU will send payout updates to Katana", { description: d.webhook_url }); qc.invalidateQueries({ queryKey: key }); },
    onError: (e: Error) => toast.error("Webhook not registered", { description: e.message }),
  });

  const valid = form.client_id && form.client_secret && /^\d+$/.test(form.payout_merchant_id);

  return (
    <Card className="mb-4">
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="text-base">PayU payout credentials</CardTitle>
          <CardDescription>With these set, this merchant’s payouts are sent through their own PayU Payouts account instead of the operator queue. Stored encrypted; never shown to the merchant.</CardDescription>
        </div>
        {!restricted && (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm" variant={status?.configured ? "secondary" : "default"}>
                <KeyRound className="h-4 w-4" /> {status?.configured ? "Rotate" : "Set credentials"}
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{status?.configured ? "Rotate" : "Set"} PayU payout credentials</DialogTitle>
                <DialogDescription>
                  From the PayU Payouts dashboard for <span className="font-mono">{merchantCode}</span>. The payout merchant ID is not the checkout MID.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div className="space-y-1.5"><Label>Client ID</Label><Input value={form.client_id} onChange={(e) => setForm({ ...form, client_id: e.target.value })} /></div>
                <div className="space-y-1.5"><Label>Client Secret</Label><Input type="password" autoComplete="off" value={form.client_secret} onChange={(e) => setForm({ ...form, client_secret: e.target.value })} /></div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5"><Label>Payout merchant ID</Label><Input inputMode="numeric" value={form.payout_merchant_id} onChange={(e) => setForm({ ...form, payout_merchant_id: e.target.value.trim() })} placeholder="1111122" /></div>
                  <div className="space-y-1.5">
                    <Label>Environment</Label>
                    <select className="flex h-9 w-full rounded-md border px-3 py-1 text-sm bg-[color:var(--color-surface)]"
                      value={form.env} onChange={(e) => setForm({ ...form, env: e.target.value })}>
                      <option value="TEST">TEST (uatoneapi.payu.in)</option>
                      <option value="PROD">PROD (payout.payumoney.com)</option>
                    </select>
                  </div>
                </div>
              </div>
              <DialogFooter>
                <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
                <Button onClick={() => save.mutate()} disabled={save.isPending || !valid}>{save.isPending ? "Saving…" : "Save"}</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </CardHeader>
      <CardContent>
        {restricted ? (
          <div className="rounded-md border px-3 py-2 text-xs text-[color:var(--color-text-muted)]">Visible to Super-Admins only.</div>
        ) : status?.configured ? (
          <div className="space-y-3 text-sm">
            <div className="space-y-1">
              <div><span className="text-[color:var(--color-text-muted)]">Payout merchant ID:</span> <span className="font-mono">{status.payout_merchant_id}</span> · <span className="text-[color:var(--color-text-muted)]">Env:</span> <Badge variant={status.env === "PROD" ? "danger" : "default"}>{status.env}</Badge></div>
              <div><span className="text-[color:var(--color-text-muted)]">Client ID:</span> <span className="font-mono">{status.client_id_hint}</span> <span className="text-[color:var(--color-text-muted)]">· secret sealed</span></div>
              <div>
                <span className="text-[color:var(--color-text-muted)]">Webhook:</span>{" "}
                {status.webhook_registered_at
                  ? <>registered {formatDateTime(status.webhook_registered_at)}</>
                  : <Badge variant="warning">not registered — results arrive only through the status check</Badge>}
              </div>
              {balance?.ok && (
                <div>
                  <span className="text-[color:var(--color-text-muted)]">PayU balance:</span>{" "}
                  <span className="tabular-nums font-medium">{formatAmount(Number(balance.balance_minor), "INR")}</span>
                  {balance.low_balance && <Badge variant="warning" className="ml-2">low</Badge>}
                </div>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => check.mutate()} disabled={check.isPending}>
                <RefreshCw className="h-4 w-4" /> {check.isPending ? "Asking PayU…" : "Check balance"}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => register.mutate()} disabled={register.isPending}>
                <Webhook className="h-4 w-4" /> {status.webhook_registered_at ? "Re-register webhook" : "Register webhook"}
              </Button>
              <Button size="sm" variant="secondary" onClick={copyEndpoint} disabled={!webhookUrl} title={webhookUrl}>
                <Copy className="h-4 w-4" /> Copy endpoint
              </Button>
            </div>
          </div>
        ) : (
          <div className="rounded-md border px-3 py-2 text-xs text-[color:var(--color-text-muted)]">
            Not set. This merchant’s payouts go to the operator queue and are paid by hand.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
