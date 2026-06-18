"use client";

// L1 — reconciliation breaks. DataView with status / break-type / unassigned
// filter chips + search.

import { useQuery } from "@tanstack/react-query";
import { GitMerge } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import { DataView } from "@/components/world-class/data-view";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface Break {
  id: string; run_id: string; reference: string; break_type: string;
  sources_present: string[]; amount: number; currency: string; delta: number;
  status: string; assignee: string; opened_at: string; resolved_at?: string;
}

export default function ReconciliationPage() {
  const q = useQuery({
    queryKey: ["recon:breaks"],
    queryFn: async () => (await fetch("/api/recon/breaks").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { breaks: Break[] },
  });
  const rows = q.data?.breaks ?? [];
  const types = Array.from(new Set(rows.map((b) => b.break_type))).slice(0, 5);

  const cols: Column<Break>[] = [
    { key: "reference", header: "Ref", render: (r) => <span className="font-mono text-xs">{r.reference}</span> },
    { key: "break_type", header: "Type", render: (r) => <Badge variant="warning">{r.break_type}</Badge> },
    { key: "sources_present", header: "Sources", render: (r) => <span className="text-xs">{(r.sources_present ?? []).join(", ") || "—"}</span> },
    { key: "amount", header: "Amount", render: (r) => <span className="tabular-nums">{formatAmount(r.amount, r.currency)}</span> },
    { key: "delta", header: "Δ", render: (r) => <span className="tabular-nums font-medium">{formatAmount(r.delta, r.currency)}</span> },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "assignee", header: "Assignee", render: (r) => r.assignee || "—" },
    { key: "opened_at", header: "Opened", render: (r) => <span className="text-xs">{formatDateTime(r.opened_at)}</span> },
  ];

  return (
    <>
      <PageHeader title="Reconciliation" description="Open breaks needing operator review." icon={GitMerge} />
      <DataView
        rows={rows} columns={cols} rowKey={(r) => r.id} loading={q.isLoading}
        search={{ placeholder: "Search by ref, assignee, type…", fields: ["reference", "assignee", "break_type"] }}
        filters={[
          { key: "open",       label: "Open",        predicate: (r: Break) => r.status !== "RESOLVED" && r.status !== "CLOSED" },
          { key: "resolved",   label: "Resolved",    predicate: (r: Break) => r.status === "RESOLVED" || r.status === "CLOSED" },
          { key: "unassigned", label: "Unassigned",  predicate: (r: Break) => !r.assignee },
          ...types.map((t) => ({ key: `t-${t}`, label: t, predicate: (r: Break) => r.break_type === t })),
        ]}
        savedViewKey="recon" refresh={() => q.refetch()}
        emptyTitle="Match is clean" emptyDescription="No outstanding recon breaks across the most recent run."
      />
    </>
  );
}
