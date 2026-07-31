"use client";

// L1 — channels. DataView with provider / direction / on-off filter chips,
// row kebab to Enable/Disable.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Network, Power, PowerOff } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import { DataView } from "@/components/world-class/data-view";
import { RowActions } from "@/components/world-class/row-actions";

interface Channel { id: string; provider: string; method: string; direction: string; enabled: boolean; weight: number; mdr_bps: number }

export default function ChannelsPage() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["channels"],
    queryFn: async () => (await fetch("/api/channels").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { channels: Channel[] },
  });
  const rows = q.data?.channels ?? [];

  const toggle = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const r = await fetch(`/api/channels/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json();
    },
    onSuccess: (_, v) => { toast.success(`Channel ${v.enabled ? "enabled" : "disabled"}`); qc.invalidateQueries({ queryKey: ["channels"] }); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const providers = Array.from(new Set(rows.map((c) => c.provider))).filter(Boolean);

  const cols: Column<Channel>[] = [
    { key: "provider", header: "Provider", render: (r) => <Badge variant="brand">{r.provider}</Badge> },
    { key: "method", header: "Method" },
    { key: "direction", header: "Direction", render: (r) => <Badge variant={r.direction === "payin" ? "info" : "warning"}>{r.direction}</Badge> },
    { key: "enabled", header: "On?", render: (r) => r.enabled ? <Badge variant="success">on</Badge> : <Badge variant="default">off</Badge> },
    { key: "weight", header: "Weight", render: (r) => <span className="tabular-nums">{r.weight}</span> },
    { key: "mdr_bps", header: "MDR (bps)", render: (r) => <span className="tabular-nums">{r.mdr_bps}</span> },
  ];

  return (
    <>
      <PageHeader
        title="Channels"
        description="Enabled payment rails — pay-in + payout × method × provider. Toggle to bring a channel online or offline."
        icon={Network}
      />
      <DataView
        rows={rows}
        columns={cols}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        search={{ placeholder: "Search by provider or method…", fields: ["provider", "method"] }}
        filters={[
          { key: "on",     label: "On",      predicate: (r: Channel) => r.enabled },
          { key: "off",    label: "Off",     predicate: (r: Channel) => !r.enabled },
          { key: "payin",  label: "Pay-in",  predicate: (r: Channel) => r.direction === "payin" },
          { key: "payout", label: "Payout",  predicate: (r: Channel) => r.direction === "payout" },
          ...providers.slice(0, 4).map((p) => ({ key: `prov-${p}`, label: p, predicate: (r: Channel) => r.provider === p })),
        ]}
        savedViewKey="channels"
        refresh={() => q.refetch()}
        emptyTitle="No channels configured"
        emptyDescription="Add channels in the routing cockpit to start orchestrating payments."
        rowActions={(r) => (
          <RowActions
            actions={[
              r.enabled
                ? { label: "Disable", icon: PowerOff, variant: "danger" as const, onClick: () => toggle.mutate({ id: r.id, enabled: false }) }
                : { label: "Enable", icon: Power, onClick: () => toggle.mutate({ id: r.id, enabled: true }) },
            ]}
          />
        )}
      />
    </>
  );
}
