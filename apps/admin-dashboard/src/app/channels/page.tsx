"use client";

import { useQuery } from "@tanstack/react-query";
import { Network } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";

interface Channel { id: string; provider: string; method: string; direction: string; enabled: boolean; weight: number; mdr_bps: number }

export default function ChannelsPage() {
  const q = useQuery({
    queryKey: ["channels"],
    queryFn: async () => (await fetch("/api/channels").then((r) => r.json())) as { channels: Channel[] },
  });
  const cols: Column<Channel>[] = [
    { key: "provider", header: "Provider" },
    { key: "method", header: "Method" },
    { key: "direction", header: "Direction" },
    { key: "enabled", header: "On?", render: (r) => r.enabled ? <Badge variant="success">on</Badge> : <Badge variant="default">off</Badge> },
    { key: "weight", header: "Weight" },
    { key: "mdr_bps", header: "MDR (bps)" },
  ];
  return (
    <>
      <PageHeader title="Channels" description="Enabled payment rails — pay-in + payout × method × provider." icon={Network} />
      <Card><CardHeader><CardTitle>{(q.data?.channels ?? []).length} channels</CardTitle></CardHeader>
        <CardContent><DataTable columns={cols} rows={q.data?.channels ?? []} loading={q.isLoading} rowKey={(r) => r.id} emptyState="No channels configured." /></CardContent>
      </Card>
    </>
  );
}
