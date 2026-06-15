"use client";

import { useQuery } from "@tanstack/react-query";
import { GitMerge } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface Record {
  id: string; merchant_id: string; partner_kind: string; partner: string;
  utr: string; payout_ref: string; txid: string; amount: number; currency: string;
  match_status: string; synced_at: string;
}

export default function PartnerDataPage() {
  const q = useQuery({
    queryKey: ["partner-data"],
    queryFn: async () => (await fetch("/api/partner-data").then((r) => r.json())) as { records: Record[] },
  });
  const cols: Column<Record>[] = [
    { key: "partner_kind", header: "Kind" },
    { key: "partner", header: "Partner" },
    { key: "utr", header: "UTR", render: (r) => <span className="font-mono text-xs">{r.utr || "—"}</span> },
    { key: "payout_ref", header: "Payout ref", render: (r) => <span className="font-mono text-xs">{r.payout_ref || "—"}</span> },
    { key: "txid", header: "TXID", render: (r) => <span className="font-mono text-xs">{r.txid ? r.txid.slice(0,16) + "…" : "—"}</span> },
    { key: "amount", header: "Amount", render: (r) => formatAmount(r.amount, r.currency) },
    { key: "match_status", header: "Match", render: (r) => <Badge variant={statusVariant(r.match_status)}>{r.match_status}</Badge> },
    { key: "synced_at", header: "Synced", render: (r) => formatDateTime(r.synced_at) },
  ];
  return (
    <>
      <PageHeader title="Partner data" description="Pulled UTR / payout-ref / TXID from settlement partners (PRODUCT_VISION §3.7)." icon={GitMerge} />
      <Card><CardHeader><CardTitle>{(q.data?.records ?? []).length} records</CardTitle></CardHeader>
        <CardContent><DataTable columns={cols} rows={q.data?.records ?? []} loading={q.isLoading} rowKey={(r) => r.id} emptyState="No partner records." /></CardContent>
      </Card>
    </>
  );
}
