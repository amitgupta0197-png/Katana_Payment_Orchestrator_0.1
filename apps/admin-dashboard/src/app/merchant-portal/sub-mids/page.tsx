"use client";

import { useQuery } from "@tanstack/react-query";
import { CreditCard } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { statusVariant } from "@/lib/utils";

interface SubMid {
  id: string; sub_mid_code: string; traffic_mode: string; kyc_status: string;
  settlement_enabled: boolean; main_mid_code: string;
}

export default function MerchantSubMidsPage() {
  const q = useQuery({
    queryKey: ["mp:sub-mids"],
    queryFn: async () => (await fetch("/api/sub-mids").then((r) => r.json())) as { sub_mids: SubMid[] },
  });

  const cols: Column<SubMid>[] = [
    { key: "sub_mid_code", header: "Sub-MID" },
    { key: "main_mid_code", header: "Main MID" },
    { key: "traffic_mode", header: "Mode", render: (r) => <Badge variant={statusVariant(r.traffic_mode)}>{r.traffic_mode}</Badge> },
    { key: "kyc_status", header: "KYC", render: (r) => <Badge variant={statusVariant(r.kyc_status)}>{r.kyc_status}</Badge> },
    { key: "settlement_enabled", header: "Settle?", render: (r) => r.settlement_enabled ? <Badge variant="success">on</Badge> : <Badge variant="default">off</Badge> },
  ];

  return (
    <>
      <PageHeader
        title="Sub-MIDs"
        description="Your active Sub-MIDs. Request new ones via your provider."
        icon={CreditCard}
      />
      <Card>
        <CardHeader><CardTitle>{(q.data?.sub_mids ?? []).length} Sub-MIDs</CardTitle></CardHeader>
        <CardContent>
          <DataTable columns={cols} rows={q.data?.sub_mids ?? []} loading={q.isLoading} rowKey={(r) => r.id} emptyState="No Sub-MIDs yet." />
        </CardContent>
      </Card>
    </>
  );
}
