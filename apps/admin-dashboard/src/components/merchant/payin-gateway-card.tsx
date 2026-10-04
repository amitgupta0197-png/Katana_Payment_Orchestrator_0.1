"use client";

// The merchant's pay-in gateway: which gateway takes their payments, with sealed credentials.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { GatewayLogo } from "@/components/merchant/gateway-logo";
import { GatewayCredentialsDialog, type GatewayForm } from "@/components/merchant/gateway-credentials-dialog";
import type { GatewayId } from "@/lib/pg-catalog";

interface PayinStatus {
  configured: boolean; gateway?: GatewayId; gateway_name?: string; connector?: boolean;
  mid_code?: string; env?: "TEST" | "PROD"; env_label?: string; key_hint?: string;
  auth?: "key_salt" | "client_credentials"; auth_label?: string | null;
  channel?: "INTENT" | "P2P";
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
      return d as { status: PayinStatus; webhook_url?: string | null; golive?: { status: "VERIFYING" | "LIVE" } | null;
        accounts?: { vault_label: string; gateway: string; env: string; mid_code: string }[] };
    },
  });
  const restricted = (q.data as { restricted?: boolean })?.restricted;
  const status = (q.data as { status?: PayinStatus })?.status;
  const webhookUrl = (q.data as { webhook_url?: string | null })?.webhook_url;
  const golive = (q.data as { golive?: { status: "VERIFYING" | "LIVE" } | null })?.golive;
  const copyEndpoint = async () => {
    if (!webhookUrl) return;
    try { await navigator.clipboard.writeText(webhookUrl); toast.success("Payment events URL copied", { description: webhookUrl }); }
    catch { toast.error("Couldn't copy", { description: webhookUrl }); }
  };

  const accounts = (q.data as { accounts?: { vault_label: string; gateway: string; env: string; mid_code: string }[] })?.accounts ?? [];
  const save = useMutation({
    mutationFn: async (form: GatewayForm & { account?: string }) => {
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
          <div className="flex flex-wrap gap-2">
            <GatewayCredentialsDialog kind="payin" merchantCode={merchantCode} configured={!!status?.configured}
              current={status?.gateway} saving={save.isPending} onSave={(f) => save.mutateAsync(f)} />
            {status?.configured && (
              <GatewayCredentialsDialog kind="payin" merchantCode={merchantCode} configured={false} addAnother
                current={status?.gateway} saving={save.isPending} onSave={(f) => save.mutateAsync({ ...f, account: "new" })} />
            )}
          </div>
        )}
      </CardHeader>
      <CardContent>
        {restricted ? (
          <div className="rounded-md border px-3 py-2 text-xs text-[color:var(--color-text-muted)]">Visible to Super-Admins only.</div>
        ) : status?.configured ? (
          <div className="text-sm space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-2 font-medium">
                {status.gateway && <GatewayLogo id={status.gateway} size={24} />}
                {status.gateway_name}
              </span>
              <Badge variant={status.env === "PROD" ? "danger" : "default"}>{status.env_label}</Badge>
              {status.auth_label && <Badge variant="default">{status.auth_label}</Badge>}
              {status.channel === "P2P" && <Badge variant="info" title="The money lands in the banker's own accounts; used for P2P orders, never for Intent">P2P flow</Badge>}
              {status.connector
                ? <Badge variant="success">Connected</Badge>
                : <Badge variant="warning">Saved — connector coming soon</Badge>}
              {golive && <Badge variant={golive.status === "LIVE" ? "success" : "warning"}>{golive.status === "LIVE" ? "Live" : "Verifying"}</Badge>}
            </div>
            {golive?.status === "VERIFYING" && (
              <div className="rounded-md border border-[color:var(--color-warning)] bg-[color:var(--color-warning-muted)] p-2 text-xs">
                This account takes only small verification payments until its go-live checklist is complete.{" "}
                <a className="font-medium underline" href="/gateway-golive">Open the checklist</a>
              </div>
            )}
            <div><span className="text-[color:var(--color-text-muted)]">Merchant ID:</span> <span className="font-mono">{status.mid_code}</span></div>
            <div><span className="text-[color:var(--color-text-muted)]">{status.auth === "client_credentials" ? "Client ID" : "Key"}:</span> <span className="font-mono">{status.key_hint}</span> <span className="text-[color:var(--color-text-muted)]">· secret sealed</span></div>
            {status.connector && webhookUrl && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <span className="text-[color:var(--color-text-muted)]">Payment events:</span>
                <span className="min-w-0 truncate font-mono text-xs">{webhookUrl}</span>
                <Button size="sm" variant="secondary" onClick={copyEndpoint}><Copy className="h-4 w-4" /> Copy</Button>
              </div>
            )}
            {accounts.length > 1 && (
              <div className="pt-1 text-xs">
                <span className="text-[color:var(--color-text-muted)]">More accounts for the MID switch:</span>{" "}
                {accounts.filter((a) => a.vault_label !== "gateway_mid").map((a) => `${a.gateway} ${a.mid_code} (${a.env})`).join(" · ")}
                {" "}— <a className="underline" href={`/mid-switch?banker=${encodeURIComponent(merchantCode)}`}>set limits and priority</a>
              </div>
            )}
            {!status.connector && (
              <div className="text-xs text-[color:var(--color-text-muted)]">Katana doesn’t route pay-ins through {status.gateway_name} yet, so this merchant’s payments keep using Katana’s current route.</div>
            )}
          </div>
        ) : (
          <div className="rounded-md border px-3 py-2 text-xs text-[color:var(--color-text-muted)]">
            No gateway connected. Connect PayU, Razorpay, Cashfree, CCAvenue, PhonePe or Paytm.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
