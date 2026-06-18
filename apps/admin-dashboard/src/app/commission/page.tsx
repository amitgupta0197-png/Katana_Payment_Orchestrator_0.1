"use client";

// L1 — commission rules. DataView with active/future/expired filter chips +
// search by provider. Read-only until POST /api/commission ships.

import { useQuery } from "@tanstack/react-query";
import { Percent } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import { DataView } from "@/components/world-class/data-view";
import { formatAmount, formatDateTime } from "@/lib/utils";

interface Rule {
  id: string; provider_id: string; rule_kind: string; rate_bps: number;
  fixed_fee: number; currency: string; valid_from: string; valid_to?: string;
}

export default function AdminCommissionPage() {
  const q = useQuery({
    queryKey: ["commission:admin"],
    queryFn: async () => (await fetch("/api/commission").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { rules: Rule[] },
  });
  const rules = q.data?.rules ?? [];
  const now = Date.now();

  const cols: Column<Rule>[] = [
    { key: "provider_id", header: "Provider", render: (r) => <span className="font-mono text-xs">{r.provider_id?.slice(0, 8) ?? "—"}…</span> },
    { key: "rule_kind", header: "Kind", render: (r) => <Badge variant="brand">{r.rule_kind}</Badge> },
    { key: "rate_bps", header: "Rate (bps)", render: (r) => <span className="tabular-nums">{r.rate_bps}</span> },
    { key: "fixed_fee", header: "Fixed", render: (r) => <span className="tabular-nums">{formatAmount(r.fixed_fee, r.currency)}</span> },
    { key: "valid_from", header: "From", render: (r) => <span className="text-xs">{formatDateTime(r.valid_from)}</span> },
    { key: "valid_to", header: "To", render: (r) => r.valid_to ? <span className="text-xs">{formatDateTime(r.valid_to)}</span> : <Badge variant="success">open</Badge> },
  ];

  return (
    <>
      <PageHeader title="Commission" description="Provider commission rules across the platform (PRODUCT_VISION §3.11). Active rules accrue against merchant volume." icon={Percent} />
      <DataView
        rows={rules}
        columns={cols}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        search={{ placeholder: "Search by provider id or rule kind…", fields: ["provider_id", "rule_kind"] }}
        filters={[
          { key: "active",   label: "Active now", predicate: (r: Rule) => {
            if (new Date(r.valid_from).getTime() > now) return false;
            if (r.valid_to && new Date(r.valid_to).getTime() < now) return false;
            return true;
          }},
          { key: "future",   label: "Future",     predicate: (r: Rule) => new Date(r.valid_from).getTime() > now },
          { key: "expired",  label: "Expired",    predicate: (r: Rule) => !!r.valid_to && new Date(r.valid_to).getTime() < now },
          { key: "open-end", label: "Open-ended", predicate: (r: Rule) => !r.valid_to },
        ]}
        savedViewKey="commission"
        refresh={() => q.refetch()}
        emptyTitle="No commission rules"
        emptyDescription="Add a rule (bps + fixed) per provider to start accruing commission."
      />
    </>
  );
}
