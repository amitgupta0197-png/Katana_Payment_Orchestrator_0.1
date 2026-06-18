"use client";

// L1 — bank adapters. Tabbed (Rails / Recent disbursements).

import { useQuery } from "@tanstack/react-query";
import { Network, Send } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataView } from "@/components/world-class/data-view";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface Rail { id: string; code: string; name: string; capabilities: string[]; health: string; created_at: string }
interface Disbursement { id: string; rail_code: string; beneficiary_ifsc: string; beneficiary_account: string; amount: number; currency: string; status: string; created_at: string }

export default function BankAdapterPage() {
  const q = useQuery({
    queryKey: ["bank-adapter"],
    queryFn: async () => (await fetch("/api/bank-adapter").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { rails: Rail[]; recent_disbursements: Disbursement[] },
  });
  const rails = q.data?.rails ?? [];
  const dis = q.data?.recent_disbursements ?? [];

  const rCols: Column<Rail>[] = [
    { key: "code", header: "Code", render: (r) => <Badge variant="brand">{r.code}</Badge> },
    { key: "name", header: "Name" },
    { key: "capabilities", header: "Capabilities", render: (r) => <span className="text-xs">{(r.capabilities ?? []).join(", ") || "—"}</span> },
    { key: "health", header: "Health", render: (r) => <Badge variant={statusVariant(r.health)}>{r.health}</Badge> },
  ];
  const dCols: Column<Disbursement>[] = [
    { key: "rail_code", header: "Rail", render: (r) => <Badge variant="brand">{r.rail_code}</Badge> },
    { key: "beneficiary_ifsc", header: "IFSC" },
    { key: "beneficiary_account", header: "Account", render: (r) => <span className="font-mono text-xs">{r.beneficiary_account}</span> },
    { key: "amount", header: "Amount", render: (r) => <span className="tabular-nums">{formatAmount(r.amount, r.currency)}</span> },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "created_at", header: "When", render: (r) => <span className="text-xs">{formatDateTime(r.created_at)}</span> },
  ];

  return (
    <>
      <PageHeader title="Bank adapters" description="Bank payout adapter pool + recent disbursements." icon={Network} />
      <Tabs defaultValue="rails">
        <TabsList>
          <TabsTrigger value="rails"><Network className="h-3.5 w-3.5" /> Rails
            <span className="ml-1 rounded-full bg-[color:var(--color-surface-muted)] px-1.5 text-xs">{rails.length}</span>
          </TabsTrigger>
          <TabsTrigger value="dis"><Send className="h-3.5 w-3.5" /> Disbursements
            <span className="ml-1 rounded-full bg-[color:var(--color-surface-muted)] px-1.5 text-xs">{dis.length}</span>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="rails">
          <DataView rows={rails} columns={rCols} rowKey={(r) => r.id} loading={q.isLoading}
            search={{ placeholder: "Search by rail code / name…", fields: ["code", "name"] }}
            filters={[
              { key: "healthy",  label: "Healthy",  predicate: (r: Rail) => r.health === "HEALTHY" || r.health === "OK" },
              { key: "degraded", label: "Degraded", predicate: (r: Rail) => r.health === "DEGRADED" || r.health === "WARN" },
              { key: "down",     label: "Down",     predicate: (r: Rail) => r.health === "DOWN" || r.health === "CRITICAL" },
            ]}
            savedViewKey="bank-rails" refresh={() => q.refetch()}
            emptyTitle="No bank rails configured" />
        </TabsContent>
        <TabsContent value="dis">
          <DataView rows={dis} columns={dCols} rowKey={(r) => r.id}
            search={{ placeholder: "Search by IFSC / account / rail…", fields: ["rail_code", "beneficiary_ifsc", "beneficiary_account"] }}
            filters={[
              { key: "completed", label: "Completed", predicate: (r: Disbursement) => r.status === "COMPLETED" || r.status === "PAID" },
              { key: "pending",   label: "Pending",   predicate: (r: Disbursement) => r.status === "PENDING" || r.status === "PROCESSING" },
              { key: "failed",    label: "Failed",    predicate: (r: Disbursement) => r.status === "FAILED" },
            ]}
            savedViewKey="bank-dis"
            emptyTitle="No disbursements yet" />
        </TabsContent>
      </Tabs>
    </>
  );
}
