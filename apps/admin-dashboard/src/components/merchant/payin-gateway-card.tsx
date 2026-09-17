"use client";

// The merchant's pay-in gateway: which gateway takes their payments, with sealed credentials.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { GatewayCredentialsDialog, type GatewayForm } from "@/components/merchant/gateway-credentials-dialog";
import type { GatewayId } from "@/lib/pg-catalog";

interface PayinStatus {
  configured: boolean; gateway?: GatewayId; gateway_name?: string; connector?: boolean;
  mid_code?: string; env?: "TEST" | "PROD"; env_label?: string; key_hint?: string;
}

export function PayinGatewayCard({ merchantId, merchantCode }: { merchantId: string; merchantCode: string }) {
  const qc = useQueryClient();
  const key = ["merchant", merchantId, "gateway-mid"];
  const q = useQuery({
    queryKey: key,
    queryFn: async () => {
      const r = await fetch(`/api/merchants/${merchantId}/gateway-mid`);
      if (r.status === 403) return { restricted: true as const };
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error((d && d.error) || "HTTP " + r.status);
      return d as { status: PayinStatus; webhook_url?: string | null };
    },
  });
  const restricted = (q.data as { restricted?: boolean })?.restricted;
  const status = (q.data as { status?: PayinStatus })?.status;
  const webhookUrl = (q.data as { webhook_url?: string | null })?.webhook_url;
  const copyEndpoint = async () => {
    if (!webhookUrl) return;
    try { await navigator.clipboard.writeText(webhookUrl); toast.success("Payment events URL copied", { description: webhookUrl }); }
    catch { toast.error("Couldn't copy", { description: webhookUrl }); }
  };

  const save = useMutation({
    mutationFn: async (form: GatewayForm) => {
      const r = await fetch(`/api/merchants/${merchantId}/gateway-mid`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Failed");
      return d;
    },
    onSuccess: () => { toast.success("Pay-in gateway saved"); qc.invalidateQueries({ queryKey: key }); },
    onError: (e: Error) => toast.error("Not saved", { description: e.message }),
  });

  return (
    <Card className="mb-4">
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="text-base">Pay-in gateway</CardTitle>
          <CardDescription>The payment gateway this merchant collects through, and the credentials Katana uses on their behalf. Stored encrypted; never shown to the merchant.</CardDescription>
        </div>
        {!restricted && (
          <GatewayCredentialsDialog kind="payin" merchantCode={merchantCode} configured={!!status?.configured}
            current={status?.gateway} saving={save.isPending} onSave={(f) => save.mutateAsync(f)} />
        )}
      </CardHeader>
      <CardContent>
        {restricted ? (
          <div className="rounded-md border px-3 py-2 text-xs text-[color:var(--color-text-muted)]">Visible to Super-Admins only.</div>
        ) : status?.configured ? (
          <div className="text-sm space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="brand">{status.gateway_name}</Badge>
              <Badge variant={status.env === "PROD" ? "danger" : "default"}>{status.env_label}</Badge>
              {status.connector
                ? <Badge variant="success">Connected</Badge>
                : <Badge variant="warning">Saved — connector coming soon</Badge>}
            </div>
            <div><span className="text-[color:var(--color-text-muted)]">Merchant ID:</span> <span className="font-mono">{status.mid_code}</span></div>
            <div><span className="text-[color:var(--color-text-muted)]">Key:</span> <span className="font-mono">{status.key_hint}</span> <span className="text-[color:var(--color-text-muted)]">· secret sealed</span></div>
            {status.connector && webhookUrl && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <span className="text-[color:var(--color-text-muted)]">Payment events:</span>
                <span className="min-w-0 truncate font-mono text-xs">{webhookUrl}</span>
                <Button size="sm" variant="secondary" onClick={copyEndpoint}><Copy className="h-4 w-4" /> Copy</Button>
              </div>
            )}
            {!status.connector && (
              <div className="text-xs text-[color:var(--color-text-muted)]">Katana doesn’t route pay-ins through {status.gateway_name} yet, so this merchant’s payments keep using Katana’s current route.</div>
            )}
          </div>
        ) : (
          <div className="rounded-md border px-3 py-2 text-xs text-[color:var(--color-text-muted)]">
            No gateway connected. Choose PayU, Razorpay, Cashfree, CCAvenue, PhonePe or Paytm.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
