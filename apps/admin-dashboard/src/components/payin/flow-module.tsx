"use client";

// One pay-in flow's sub-module (P2P or Intent): its orders, read from the flow's own table,
// and the merchants and bankers on it. The two flows share this screen but never each other's
// data: P2P shows the payee UPI ID and the UTR evidence, Intent shows the gateway and its ids.

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeftRight, Building2, Smartphone } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Column } from "@/components/ui/data-table";
import { DataView } from "@/components/world-class/data-view";
import { KpiTile } from "@/components/world-class/kpi-tile";
import { FlowBankersTable, FlowMerchantsTable, useFlows } from "@/components/payin/flow-lists";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";
import { gatewayName } from "@/lib/pg-catalog";
import { PAYIN_FLOW_HINT, PAYIN_FLOW_LABEL, type OrderFlow } from "@/lib/payin-flow";

interface Order {
  id: string; ref: string; order_id: string; merchant_id: string | null; amount: number; status: string; created_at: string;
  evidence: string | null; confirmed_by: string | null; confirmed_at: string | null;
  // P2P
  pay_mode?: string | null; payee_vpa?: string | null; payer_vpa?: string | null; utr?: string | null;
  proof_status?: string | null; on_hold?: boolean;
  // Intent
  gateway?: string | null; gateway_env?: string | null; gateway_txn_id?: string | null; gateway_payment_id?: string | null;
  bank_ref?: string | null; hosted_page?: boolean; payout_status?: string | null;
}
interface OrdersData {
  totals: { n: number; amount: number; paid_n: number; paid_amount: number };
  by_status: { status: string; n: number; amount: number }[];
  by_merchant: { merchant_id: string; n: number; paid_amount: number }[];
  orders: Order[]; truncated: boolean;
}

const DASH = <span className="text-[color:var(--color-text-muted)]">—</span>;
const mono = (v: string | null | undefined) => (v ? <span className="font-mono text-xs">{v}</span> : DASH);

function Orders({ flow }: { flow: OrderFlow }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const seg = flow === "P2P" ? "p2p" : "intent";
  const q = useQuery({
    queryKey: ["payin-flow-orders", flow, from, to],
    queryFn: async () => {
      const sp = new URLSearchParams();
      if (from) sp.set("from", from);
      if (to) sp.set("to", to);
      const r = await fetch(`/api/payin-flows/${seg}/orders?${sp}`);
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error(d?.error ?? "Could not load orders");
      return d as OrdersData;
    },
    refetchInterval: 30_000,
  });
  const t = q.data?.totals;
  const count = (s: string) => q.data?.by_status.find((x) => x.status === s)?.n ?? 0;

  const common: Column<Order>[] = [
    { key: "ref", header: flow === "P2P" ? "P2P ref" : "Intent ref", render: (r) => <span className="font-mono text-xs font-medium">{r.ref}</span> },
    { key: "order_id", header: "Merchant order", render: (r) => <Link className="text-[color:var(--color-brand)] hover:underline" href={`/pay/${r.id}`} target="_blank">{r.order_id}</Link> },
    { key: "merchant_id", header: "Banker", render: (r) => mono(r.merchant_id) },
    { key: "amount", header: "Amount", render: (r) => <span className="tabular-nums">{formatAmount(r.amount)}</span> },
    { key: "status", header: "Status", render: (r) => (
      <span className="inline-flex items-center gap-1.5">
        <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
        {r.on_hold && <Badge variant="warning">held</Badge>}
        {r.proof_status === "PROOF_SUBMITTED" && <Badge variant="info">proof</Badge>}
      </span>
    ) },
  ];
  const own: Column<Order>[] = flow === "P2P" ? [
    { key: "payee_vpa", header: "Paid to (UPI ID)", render: (r) => mono(r.payee_vpa) },
    { key: "utr", header: "UTR", render: (r) => mono(r.utr) },
    { key: "evidence", header: "Evidence", render: (r) => (r.evidence ? <span className="text-xs">{r.evidence.toLowerCase()}</span> : DASH) },
  ] : [
    { key: "gateway", header: "Gateway", render: (r) => (r.gateway
      ? <span className="inline-flex items-center gap-1.5">{gatewayName(r.gateway)}{r.gateway_env && r.gateway_env !== "PROD" && <Badge variant="warning">{r.gateway_env.toLowerCase()}</Badge>}{r.hosted_page && <Badge>hosted page</Badge>}</span>
      : DASH) },
    { key: "gateway_txn_id", header: "Gateway txn", render: (r) => mono(r.gateway_txn_id) },
    { key: "bank_ref", header: "Bank ref", render: (r) => mono(r.bank_ref) },
  ];
  const cols: Column<Order>[] = [...common, ...own,
    { key: "created_at", header: "Created", render: (r) => <span className="text-xs">{formatDateTime(r.created_at)}</span> }];

  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiTile label="Orders" value={t ? t.n : "—"} sublabel={t ? formatAmount(t.amount) : ""} loading={q.isLoading} />
        <KpiTile label="Paid" value={t ? formatAmount(t.paid_amount) : "—"} sublabel={t ? `${t.paid_n} orders` : ""} loading={q.isLoading} variant="success" />
        <KpiTile label="Pending" value={count("PENDING") + count("INITIATED")} sublabel="awaiting payment" loading={q.isLoading} />
        <KpiTile label="Failed / expired" value={count("FAILED") + count("EXPIRED")} sublabel="not paid" loading={q.isLoading} />
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-[color:var(--color-text-muted)]">From</span>
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9 w-40" />
        <span className="text-[color:var(--color-text-muted)]">to</span>
        <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-9 w-40" />
        <span className="text-xs text-[color:var(--color-text-muted)]">IST days · follows the Test / Live switch</span>
      </div>
      {q.isError && <div className="mb-3 text-sm text-[color:var(--color-danger)]">{(q.error as Error).message}</div>}
      <DataView
        rows={q.data?.orders ?? []} columns={cols} rowKey={(r) => r.id} loading={q.isLoading}
        search={{ placeholder: "Search by reference, order, banker…", fields: ["ref", "order_id", (r) => r.merchant_id ?? "", (r) => r.utr ?? r.bank_ref ?? "", (r) => r.gateway_txn_id ?? ""] }}
        filters={[
          { key: "paid", label: "Paid", predicate: (r: Order) => r.status === "SUCCESS" || r.status === "SUCCEEDED" },
          { key: "pending", label: "Pending", predicate: (r: Order) => r.status === "PENDING" || r.status === "INITIATED" },
          { key: "failed", label: "Failed / expired", predicate: (r: Order) => r.status === "FAILED" || r.status === "EXPIRED" },
          ...(flow === "P2P" ? [{ key: "no-utr", label: "Paid, no UTR", predicate: (r: Order) => (r.status === "SUCCESS" || r.status === "SUCCEEDED") && !r.utr }] : []),
        ]}
        savedViewKey={`payin-flow-${seg}-orders`} refresh={() => q.refetch()}
        emptyTitle={`No ${PAYIN_FLOW_LABEL[flow]} orders in this window`}
        emptyDescription={flow === "P2P" ? "Orders paid to a banker's own UPI ID appear here." : "Orders taken by a payment gateway appear here."}
      />
      {q.data?.truncated && <p className="mt-2 text-xs text-[color:var(--color-text-muted)]">Showing the newest 200 orders. The totals above cover the whole window.</p>}
    </>
  );
}

export function FlowModule({ flow }: { flow: OrderFlow }) {
  const flows = useFlows(flow);
  return (
    <>
      <PageHeader title={`${PAYIN_FLOW_LABEL[flow]} Pay-ins`} icon={flow === "P2P" ? Smartphone : Building2}
        description={`${PAYIN_FLOW_HINT[flow]} Merchants and bankers set to Both are listed here too.`}
        actions={<Link href="/payin-flows" className="inline-flex items-center gap-1.5 text-sm text-[color:var(--color-brand)] hover:underline"><ArrowLeftRight className="h-4 w-4" /> All flows</Link>} />
      <Tabs defaultValue="orders">
        <TabsList>
          <TabsTrigger value="orders">Orders</TabsTrigger>
          <TabsTrigger value="merchants">Merchants ({flows.data?.merchants.length ?? 0})</TabsTrigger>
          <TabsTrigger value="bankers">Bankers ({flows.data?.bankers.length ?? 0})</TabsTrigger>
        </TabsList>
        <TabsContent value="orders" className="mt-4"><Orders flow={flow} /></TabsContent>
        <TabsContent value="merchants" className="mt-4">
          <FlowMerchantsTable rows={flows.data?.merchants ?? []} loading={flows.isLoading} refresh={() => flows.refetch()} viewKey={`payin-flow-${flow}-merchants`} />
        </TabsContent>
        <TabsContent value="bankers" className="mt-4">
          <FlowBankersTable rows={flows.data?.bankers ?? []} loading={flows.isLoading} refresh={() => flows.refetch()} viewKey={`payin-flow-${flow}-bankers`} flow={flow} />
        </TabsContent>
      </Tabs>
    </>
  );
}
