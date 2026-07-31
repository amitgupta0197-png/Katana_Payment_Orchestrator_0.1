"use client";

// L1 — PoolPay vendor cockpit. Tabbed (Orders / Credentials).

import { useQuery } from "@tanstack/react-query";
import { CreditCard, KeyRound, Copy, ExternalLink, Webhook, Banknote } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Column } from "@/components/ui/data-table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataView } from "@/components/world-class/data-view";
import { PoolPayCreateOrder } from "@/components/vendors/poolpay-create-order";
import { PoolPayConfirm } from "@/components/vendors/poolpay-confirm";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

const TERMINAL = new Set(["SUCCESS", "SUCCEEDED", "FAILED", "EXPIRED"]);

interface Order { id: string; pay_id: string; order_id: string; merchant_id: string; sub_mid_code: string; amount: number; currency_code: string; channel: string; vendor_txn_id: string; rrn: string; response_code: string; status: string; review: string; proof_utr: string; confirm_evidence: string; created_at: string }
interface Credential { id: string; vendor: string; env: string; pay_id: string; active: boolean; created_at: string }

export default function PoolPayCockpit() {
  const q = useQuery({
    queryKey: ["vendor:poolpay"],
    queryFn: async () => (await fetch("/api/vendors/poolpay/payin").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { orders: Order[]; credentials: Credential[] },
  });
  const orders = q.data?.orders ?? [];
  const creds = q.data?.credentials ?? [];

  // Demo helper: fire a sample signed settlement webhook at the real public endpoint
  // (sandbox has no live gateway). Confirms the order via the gateway-callback path.
  const simulateWebhook = async (id: string) => {
    try {
      const r = await fetch(`/api/vendors/poolpay/order/${id}/simulate-webhook`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcome: "SUCCESS" }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Webhook failed");
      toast.success("Gateway webhook received — order confirmed paid");
      q.refetch();
    } catch (e) { toast.error("Simulate webhook failed", { description: (e as Error).message }); }
  };

  // Simulate the device/SMS bank-credit alert → reconciler matches & confirms.
  const simulateCredit = async (id: string) => {
    try {
      const r = await fetch(`/api/vendors/poolpay/order/${id}/simulate-credit`, { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Failed");
      if (d.outcome === "CONFIRMED") toast.success("Bank credit matched — order confirmed paid");
      else toast.info(`Alert ${String(d.outcome).toLowerCase()}`, { description: d.detail });
      q.refetch();
    } catch (e) { toast.error("Simulate bank credit failed", { description: (e as Error).message }); }
  };

  const cols: Column<Order>[] = [
    { key: "order_id", header: "Order", render: (r) => <span className="font-mono text-xs">{r.order_id}</span> },
    { key: "merchant_id", header: "Branch", render: (r) => r.merchant_id ? <span className="font-mono text-xs">{r.merchant_id}</span> : <span className="text-xs text-[color:var(--color-text-subtle)]">test</span> },
    { key: "sub_mid_code", header: "Sub-MID", render: (r) => r.sub_mid_code ? <Badge variant="info">{r.sub_mid_code}</Badge> : <span className="text-xs text-[color:var(--color-text-subtle)]">—</span> },
    { key: "amount", header: "Amount", render: (r) => <span className="tabular-nums">{formatAmount(r.amount, r.currency_code)}</span> },
    { key: "channel", header: "Channel" },
    { key: "vendor_txn_id", header: "Vendor txn", render: (r) => r.vendor_txn_id ? <span className="font-mono text-xs">{r.vendor_txn_id}</span> : "—" },
    { key: "rrn", header: "RRN", render: (r) => r.rrn || "—" },
    { key: "response_code", header: "Code" },
    { key: "status", header: "Status", render: (r) => (
      <div className="flex items-center gap-1.5">
        <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
        {r.review === "PROOF_SUBMITTED" && <Badge variant="warning" title={r.proof_utr ? `Sender UTR: ${r.proof_utr}` : "Sender uploaded a screenshot"}>proof</Badge>}
      </div>
    ) },
    { key: "created_at", header: "Created", render: (r) => <span className="text-xs">{formatDateTime(r.created_at)}</span> },
    { key: "actions", header: "Actions", render: (r) => (
      <div className="flex items-center gap-1">
        {!TERMINAL.has(r.status) && <PoolPayConfirm id={r.id} orderId={r.order_id} proofUtr={r.proof_utr} hasProof={r.review === "PROOF_SUBMITTED"} onDone={() => q.refetch()} />}
        {!TERMINAL.has(r.status) && (
          <Button size="sm" variant="ghost" title="Simulate bank-credit alert (device) — match & confirm" onClick={() => simulateCredit(r.id)}>
            <Banknote className="h-3.5 w-3.5" />
          </Button>
        )}
        {!TERMINAL.has(r.status) && (
          <Button size="sm" variant="ghost" title="Simulate gateway settlement webhook (sandbox)" onClick={() => simulateWebhook(r.id)}>
            <Webhook className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button size="sm" variant="ghost" title="Copy customer payment link"
          onClick={() => { navigator.clipboard?.writeText(`${window.location.origin}/pay/${r.id}`); toast.success("Payment link copied"); }}>
          <Copy className="h-3.5 w-3.5" />
        </Button>
        <Button asChild size="sm" variant="ghost" title="Open payment page">
          <a href={`/pay/${r.id}`} target="_blank" rel="noopener noreferrer"><ExternalLink className="h-3.5 w-3.5" /></a>
        </Button>
      </div>
    ) },
  ];
  const credCols: Column<Credential>[] = [
    { key: "env", header: "Env" },
    { key: "pay_id", header: "Pay ID", render: (r) => <span className="font-mono text-xs">{r.pay_id}</span> },
    { key: "active", header: "Active", render: (r) => r.active ? <Badge variant="success">on</Badge> : <Badge variant="default">off</Badge> },
    { key: "created_at", header: "Created", render: (r) => <span className="text-xs">{formatDateTime(r.created_at)}</span> },
  ];

  return (
    <>
      <PageHeader title="Katana Pay cockpit" description="Sandbox dispatcher + production observability (PRODUCT_VISION §3.6)." icon={CreditCard} />
      <div className="mb-4">
        <PoolPayCreateOrder onChange={() => q.refetch()} />
      </div>
      <Tabs defaultValue="orders">
        <TabsList>
          <TabsTrigger value="orders">Orders
            <span className="ml-1 rounded-full bg-[color:var(--color-surface-muted)] px-1.5 text-xs">{orders.length}</span>
          </TabsTrigger>
          <TabsTrigger value="creds"><KeyRound className="h-3.5 w-3.5" /> Credentials
            <span className="ml-1 rounded-full bg-[color:var(--color-surface-muted)] px-1.5 text-xs">{creds.length}</span>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="orders">
          <DataView rows={orders} columns={cols} rowKey={(r) => r.id} loading={q.isLoading}
            search={{ placeholder: "Search by order / branch / RRN / vendor txn…", fields: ["order_id", "merchant_id", "vendor_txn_id", "rrn", "channel"] }}
            filters={[
              { key: "success", label: "Success", predicate: (r: Order) => r.status === "SUCCEEDED" || r.status === "SUCCESS" },
              { key: "failed",  label: "Failed",  predicate: (r: Order) => r.status === "FAILED" },
              { key: "pending", label: "Pending", predicate: (r: Order) => r.status === "PENDING" || r.status === "INITIATED" },
            ]}
            savedViewKey="vendor-poolpay" refresh={() => q.refetch()}
            emptyTitle="No Katana Pay orders yet" />
        </TabsContent>
        <TabsContent value="creds">
          <DataView rows={creds} columns={credCols} rowKey={(r) => r.id}
            search={{ placeholder: "Search by env / pay id…", fields: ["env", "pay_id"] }}
            savedViewKey="vendor-poolpay-creds"
            emptyTitle="No credentials configured" />
        </TabsContent>
      </Tabs>
    </>
  );
}
