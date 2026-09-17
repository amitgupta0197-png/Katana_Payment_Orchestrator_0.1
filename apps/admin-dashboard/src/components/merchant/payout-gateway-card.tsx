"use client";

// The merchant's payout gateway: which gateway pays out for them, with sealed credentials.
// For a gateway with a payout connector it also checks the balance (where the gateway has a
// balance API), registers the webhook (PayU) or copies the URL to set in the gateway's
// dashboard. Secrets are write-only here.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, RefreshCw, Webhook } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { GatewayCredentialsDialog, type GatewayForm } from "@/components/merchant/gateway-credentials-dialog";
import { formatAmount, formatDateTime } from "@/lib/utils";
import type { GatewayId } from "@/lib/pg-catalog";

interface PayoutStatus {
  configured: boolean; gateway?: GatewayId; gateway_name?: string; connector?: boolean;
  webhook?: "api" | "dashboard" | "per_transfer" | null; balance?: boolean;
  env?: "TEST" | "PROD"; env_label?: string;
  summary?: { label: string; value: string }[];
  webhook_registered_at?: string | null;
}
type Balance = { ok: true; balance_minor: string; low_balance: boolean } | { ok: false; error: string };

async function readJson(r: Response) {
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
  return d;
}

export function PayoutGatewayCard({ merchantId, merchantCode }: { merchantId: string; merchantCode: string }) {
  const qc = useQueryClient();
  const base = `/api/merchants/${merchantId}/payout-gateway`;
  const key = ["merchant", merchantId, "payout-gateway"];
  const statusQ = useQuery({
    queryKey: key,
    queryFn: async () => {
      const r = await fetch(base);
      if (r.status === 403) return { restricted: true as const };
      return (await readJson(r)) as { status: PayoutStatus; webhook_url: string };
    },
  });
  const restricted = (statusQ.data as { restricted?: boolean })?.restricted;
  const status = (statusQ.data as { status?: PayoutStatus })?.status;
  const webhookUrl = (statusQ.data as { webhook_url?: string })?.webhook_url;
  const [balance, setBalance] = useState<Balance | null>(null);

  const copyEndpoint = async () => {
    if (!webhookUrl) return;
    try { await navigator.clipboard.writeText(webhookUrl); toast.success("Webhook endpoint copied", { description: webhookUrl }); }
    catch { toast.error("Couldn't copy", { description: webhookUrl }); }
  };

  const save = useMutation({
    mutationFn: async (form: GatewayForm) => readJson(await fetch(base, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form),
    })),
    onSuccess: () => { toast.success("Payout gateway saved"); setBalance(null); qc.invalidateQueries({ queryKey: key }); },
    onError: (e: Error) => toast.error("Not saved", { description: e.message }),
  });
  const check = useMutation({
    mutationFn: async () => (await readJson(await fetch(`${base}?balance=1`))).balance as Balance,
    onSuccess: (b) => { setBalance(b); if (!b.ok) toast.error("No balance", { description: b.error }); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });
  const register = useMutation({
    mutationFn: async () => readJson(await fetch(`${base}?action=register-webhook`, { method: "POST" })),
    onSuccess: (d) => { toast.success("Payout updates will be sent to Katana", { description: d.webhook_url }); qc.invalidateQueries({ queryKey: key }); },
    onError: (e: Error) => toast.error("Webhook not registered", { description: e.message }),
  });

  return (
    <Card className="mb-4">
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="text-base">Payout gateway</CardTitle>
          <CardDescription>The gateway this merchant’s payouts are sent through, from their own account. Stored encrypted; never shown to the merchant.</CardDescription>
        </div>
        {!restricted && (
          <GatewayCredentialsDialog kind="payout" merchantCode={merchantCode} configured={!!status?.configured}
            current={status?.gateway} saving={save.isPending} onSave={(f) => save.mutateAsync(f)} />
        )}
      </CardHeader>
      <CardContent>
        {restricted ? (
          <div className="rounded-md border px-3 py-2 text-xs text-[color:var(--color-text-muted)]">Visible to Super-Admins only.</div>
        ) : status?.configured ? (
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="brand">{status.gateway_name}</Badge>
              <Badge variant={status.env === "PROD" ? "danger" : "default"}>{status.env_label}</Badge>
              {status.connector
                ? <Badge variant="success">Connected</Badge>
                : <Badge variant="warning">Saved — connector coming soon</Badge>}
            </div>
            <div className="space-y-1">
              {status.summary?.map((s) => (
                <div key={s.label}><span className="text-[color:var(--color-text-muted)]">{s.label}:</span> <span className="font-mono">{s.value}</span></div>
              ))}
              {status.connector && (
                <div>
                  <span className="text-[color:var(--color-text-muted)]">Webhook:</span>{" "}
                  {status.webhook === "per_transfer"
                    ? <>sent with every transfer — nothing to set up</>
                    : status.webhook === "dashboard"
                      ? <>add the endpoint below in the {status.gateway_name} dashboard (payout events); until then results arrive through the status check</>
                      : status.webhook_registered_at
                        ? <>registered {formatDateTime(status.webhook_registered_at)}</>
                        : <Badge variant="warning">not registered — results arrive only through the status check</Badge>}
                </div>
              )}
              {balance?.ok && (
                <div>
                  <span className="text-[color:var(--color-text-muted)]">Balance:</span>{" "}
                  <span className="tabular-nums font-medium">{formatAmount(Number(balance.balance_minor), "INR")}</span>
                  {balance.low_balance && <Badge variant="warning" className="ml-2">low</Badge>}
                </div>
              )}
            </div>
            {status.connector ? (
              <div className="flex flex-wrap gap-2">
                {status.balance && (
                  <Button size="sm" variant="secondary" onClick={() => check.mutate()} disabled={check.isPending}>
                    <RefreshCw className="h-4 w-4" /> {check.isPending ? `Asking ${status.gateway_name}…` : "Check balance"}
                  </Button>
                )}
                {status.webhook === "api" && (
                  <Button size="sm" variant="secondary" onClick={() => register.mutate()} disabled={register.isPending}>
                    <Webhook className="h-4 w-4" /> {status.webhook_registered_at ? "Re-register webhook" : "Register webhook"}
                  </Button>
                )}
                {status.webhook !== "per_transfer" && (
                  <Button size="sm" variant="secondary" onClick={copyEndpoint} disabled={!webhookUrl} title={webhookUrl}>
                    <Copy className="h-4 w-4" /> Copy endpoint
                  </Button>
                )}
              </div>
            ) : (
              <div className="text-xs text-[color:var(--color-text-muted)]">
                Katana doesn’t send payouts through {status.gateway_name} yet, so this merchant’s payouts stay in the operator queue and are paid by hand.
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-md border px-3 py-2 text-xs text-[color:var(--color-text-muted)]">
            No payout gateway. This merchant’s payouts go to the operator queue and are paid by hand.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
