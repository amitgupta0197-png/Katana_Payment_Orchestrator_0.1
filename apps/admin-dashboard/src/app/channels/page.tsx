"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Network } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";

interface Channel { id: string; provider: string; method: string; direction: string; enabled: boolean; weight: number; mdr_bps: number }

function ToggleButton({ channel }: { channel: Channel }) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/channels/${channel.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !channel.enabled }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json();
    },
    onSuccess: () => { toast.success(`Channel ${channel.enabled ? "disabled" : "enabled"}`); qc.invalidateQueries({ queryKey: ["channels"] }); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });
  return (
    <Button size="sm" variant={channel.enabled ? "secondary" : "default"} onClick={() => m.mutate()} disabled={m.isPending}>
      {channel.enabled ? "Disable" : "Enable"}
    </Button>
  );
}

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
    { key: "actions", header: "", render: (r) => <ToggleButton channel={r} /> },
  ];
  return (
    <>
      <PageHeader title="Channels" description="Enabled payment rails — pay-in + payout × method × provider. Toggle to bring a channel online or take it offline." icon={Network} />
      <Card><CardHeader><CardTitle>{(q.data?.channels ?? []).length} channels</CardTitle></CardHeader>
        <CardContent><DataTable columns={cols} rows={q.data?.channels ?? []} loading={q.isLoading} rowKey={(r) => r.id} emptyState="No channels configured." /></CardContent>
      </Card>
    </>
  );
}
