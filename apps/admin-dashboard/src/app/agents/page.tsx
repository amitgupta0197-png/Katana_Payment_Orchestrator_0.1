"use client";

// L1 — agents / franchise. DataView with tier + status chips + search.

import { useQuery } from "@tanstack/react-query";
import { Users } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import { DataView } from "@/components/world-class/data-view";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface Agent {
  id: string; code: string; parent_id: string; tier: string; legal_name: string;
  contact_email: string; contact_phone: string; status: string;
  advance_balance: number; currency: string; low_balance_threshold: number; created_at: string;
}

export default function AgentsPage() {
  const q = useQuery({
    queryKey: ["agents"],
    queryFn: async () => (await fetch("/api/agents").then((r) => r.json())) as { agents: Agent[] },
  });
  const rows = q.data?.agents ?? [];
  const tiers = Array.from(new Set(rows.map((a) => a.tier))).slice(0, 5);

  const cols: Column<Agent>[] = [
    { key: "code", header: "Code", render: (r) => <span className="font-mono text-xs">{r.code}</span> },
    { key: "tier", header: "Tier", render: (r) => <Badge variant="brand">{r.tier}</Badge> },
    { key: "legal_name", header: "Legal name" },
    { key: "contact_email", header: "Contact" },
    { key: "advance_balance", header: "Advance", render: (r) => <span className={`tabular-nums ${r.advance_balance <= r.low_balance_threshold ? "text-[color:var(--color-danger)]" : ""}`}>{formatAmount(r.advance_balance, r.currency)}</span> },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "created_at", header: "Joined", render: (r) => <span className="text-xs">{formatDateTime(r.created_at)}</span> },
  ];

  return (
    <>
      <PageHeader title="Agents & franchise" description="Sub-admin franchise tree (PRODUCT_VISION §3.11)." icon={Users} />
      <DataView rows={rows} columns={cols} rowKey={(r) => r.id} loading={q.isLoading}
        search={{ placeholder: "Search by code / name / contact…", fields: ["code", "legal_name", "contact_email", "contact_phone"] }}
        filters={[
          { key: "active",   label: "Active",       predicate: (r: Agent) => r.status === "ACTIVE" },
          { key: "low-bal",  label: "Low balance",  predicate: (r: Agent) => r.advance_balance <= r.low_balance_threshold },
          ...tiers.map((t) => ({ key: `t-${t}`, label: t, predicate: (r: Agent) => r.tier === t })),
        ]}
        savedViewKey="agents" refresh={() => q.refetch()}
        emptyTitle="No agents in tree" />
    </>
  );
}
