"use client";

// L1 — partner data sync. DataView with match-status + partner chips.

import { useQuery } from "@tanstack/react-query";
import { GitMerge } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import { DataView } from "@/components/world-class/data-view";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface Record {
  id: string; merchant_id: string; partner_kind: string; partner: string;
  utr: string; payout_ref: string; txid: string; amount: number; currency: string;
  match_status: string; synced_at: string;
}

export default function PartnerDataPage() {
  const q = useQuery({
    queryKey: ["partner-data"],
    queryFn: async () => (await fetch("/api/partner-data").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { records: Record[] },
  });
  const rows = q.data?.records ?? [];
  const partners = Array.from(new Set(rows.map((r) => r.partner))).slice(0, 5);

  const cols: Column<Record>[] = [
    { key: "partner_kind", header: "Kind", render: (r) => <Badge variant="info">{r.partner_kind}</Badge> },
    { key: "partner", header: "Partner", render: (r) => <Badge variant="brand">{r.partner}</Badge> },
    { key: "utr", header: "UTR", render: (r) => <span className="font-mono text-xs">{r.utr || "—"}</span> },
    { key: "payout_ref", header: "Payout ref", render: (r) => <span className="font-mono text-xs">{r.payout_ref || "—"}</span> },
    { key: "txid", header: "TXID", render: (r) => <span className="font-mono text-xs">{r.txid ? r.txid.slice(0, 16) + "…" : "—"}</span> },
    { key: "amount", header: "Amount", render: (r) => <span className="tabular-nums">{formatAmount(r.amount, r.currency)}</span> },
    { key: "match_status", header: "Match", render: (r) => <Badge variant={statusVariant(r.match_status)}>{r.match_status}</Badge> },
    { key: "synced_at", header: "Synced", render: (r) => <span className="text-xs">{formatDateTime(r.synced_at)}</span> },
  ];

  return (
    <>
      <PageHeader title="Partner data" description="Pulled UTR / payout-ref / TXID from settlement partners (PRODUCT_VISION §3.7)." icon={GitMerge} />
      <DataView rows={rows} columns={cols} rowKey={(r) => r.id} loading={q.isLoading}
        search={{ placeholder: "Search by UTR / TXID / merchant…", fields: ["utr", "payout_ref", "txid", "merchant_id", "partner"] }}
        filters={[
          { key: "matched",   label: "Matched",   predicate: (r: Record) => r.match_status === "MATCHED" },
          { key: "unmatched", label: "Unmatched", predicate: (r: Record) => r.match_status === "UNMATCHED" },
          { key: "review",    label: "Needs review", predicate: (r: Record) => r.match_status === "REVIEW" },
          ...partners.map((p) => ({ key: `p-${p}`, label: p, predicate: (r: Record) => r.partner === p })),
        ]}
        savedViewKey="partner-data" refresh={() => q.refetch()}
        emptyTitle="No partner records" />
    </>
  );
}
