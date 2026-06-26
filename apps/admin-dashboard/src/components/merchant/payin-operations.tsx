"use client";

// Merchant module operations: which pay-ins are currently active for this
// merchant, their mode (QR/non-QR), active receiver VPA + backup-pool health,
// with a one-click VPA failover and the shareable pay link. Admin-visible.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, ExternalLink, SkipForward, QrCode, Smartphone, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface Order {
  id: string; order_id: string; vendor: string; amount: number; currency_code: string;
  status: string; mode: string; active_vpa: string | null; vpa_total: number; vpa_remaining: number;
  sub_mid_code: string; hold?: boolean; hold_reason?: string | null; terminal: boolean; created_at: string;
}

export function PayinOperationsCard({ merchantId }: { merchantId: string }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["merchant", merchantId, "payin-orders"],
    queryFn: async () => {
      const r = await fetch(`/api/merchants/${merchantId}/payin-orders`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return (await r.json()) as { merchant_code: string; live: Order[]; all: Order[] };
    },
    refetchInterval: 10_000,
  });

  const advance = useMutation({
    mutationFn: async (orderId: string) => {
      const r = await fetch(`/api/vendors/poolpay/order/${orderId}/advance-vpa`, { method: "POST" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json() as Promise<{ active_vpa: string; remaining: number }>;
    },
    onSuccess: (d) => { toast.success(`Failed over to ${d.active_vpa}`, { description: `${d.remaining} backup VPA(s) left` }); qc.invalidateQueries({ queryKey: ["merchant", merchantId, "payin-orders"] }); },
    onError: (e: Error) => toast.error("Cannot fail over", { description: e.message }),
  });

  const refresh = useMutation({
    mutationFn: async (orderId: string) => {
      const r = await fetch(`/api/vendors/poolpay/order/${orderId}/refresh`, { method: "POST" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json() as Promise<{ status: string; changed: boolean }>;
    },
    onSuccess: (d) => { toast[d.changed ? "success" : "info"](`Status: ${d.status}`); qc.invalidateQueries({ queryKey: ["merchant", merchantId, "payin-orders"] }); },
    onError: (e: Error) => toast.error("Refresh failed", { description: e.message }),
  });

  const live = q.data?.live ?? [];
  const copyLink = (id: string) => { navigator.clipboard?.writeText(`${window.location.origin}/pay/${id}`); toast.success("Pay link copied"); };

  return (
    <Card className="mb-4">
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="text-base">Active payments (operations)</CardTitle>
          <CardDescription>Live pay-ins for this merchant — mode, active receiver VPA, backup failover.</CardDescription>
        </div>
        <Badge variant={live.length ? "success" : "default"}>{live.length} active</Badge>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <div className="py-4 text-center text-sm text-[color:var(--color-text-muted)]">Loading…</div>
        ) : live.length === 0 ? (
          <div className="rounded-xl border border-dashed px-3 py-5 text-center text-sm text-[color:var(--color-text-muted)]">
            No active pay-ins. Create one from the PoolPay cockpit or the merchant API.
          </div>
        ) : (
          <ul className="space-y-2">
            {live.map((o) => (
              <li key={o.id} className="rounded-xl border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs">{o.order_id}</span>
                      <Badge variant="brand">{o.vendor}</Badge>
                      <Badge variant="default">{o.mode === "QR" ? <><QrCode className="mr-1 h-3 w-3" />QR</> : <><Smartphone className="mr-1 h-3 w-3" />deeplink</>}</Badge>
                      {o.sub_mid_code && <Badge variant="info">{o.sub_mid_code}</Badge>}
                      {o.hold && <Badge variant="warning" title={o.hold_reason ?? "manual review"}>HELD · review</Badge>}
                      <Badge variant={statusVariant(o.status)}>{o.status}</Badge>
                    </div>
                    <div className="mt-1 text-xs text-[color:var(--color-text-muted)]">
                      {formatAmount(o.amount, o.currency_code)} · {formatDateTime(o.created_at)}
                      {o.active_vpa ? <> · payee <span className="font-mono">{o.active_vpa}</span></> : null}
                      {o.vpa_total > 1 ? <> · VPA pool {o.vpa_remaining}/{o.vpa_total - 1} backups left</> : null}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button size="sm" variant="ghost" title="Copy pay link" onClick={() => copyLink(o.id)}><Copy className="h-3.5 w-3.5" /></Button>
                    <Button asChild size="sm" variant="ghost" title="Open payment page"><a href={`/pay/${o.id}`} target="_blank" rel="noopener noreferrer"><ExternalLink className="h-3.5 w-3.5" /></a></Button>
                    <Button size="sm" variant="ghost" title="Force status refresh" disabled={refresh.isPending} onClick={() => refresh.mutate(o.id)}><RefreshCw className="h-3.5 w-3.5" /></Button>
                    <Button size="sm" variant="secondary" disabled={o.vpa_remaining < 1 || advance.isPending}
                      title={o.vpa_remaining < 1 ? "No backup VPA left" : "VPA can't receive — fail over to next"}
                      onClick={() => advance.mutate(o.id)}>
                      <SkipForward className="h-3.5 w-3.5" /> Next VPA
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
