"use client";

// L1 — event stream. DataView with event-type filter chips, search by
// entity/producer, auto-refresh toggle in the header.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import { DataView } from "@/components/world-class/data-view";
import { formatDateTime } from "@/lib/utils";

interface Event {
  event_id: string; event_type: string; producer: string;
  entity_type: string; entity_id: string; actor_id?: string;
  payload: Record<string, unknown>; created_at: string;
}

function badgeForType(t: string): "brand" | "success" | "warning" | "danger" | "default" {
  if (t.startsWith("payment.succeeded") || t.endsWith(".decided")) return "success";
  if (t.startsWith("risk.") || t.includes("break")) return "danger";
  if (t.startsWith("maker_checker")) return "warning";
  return "brand";
}

export default function EventsPage() {
  const [autoRefresh, setAutoRefresh] = useState(true);
  const q = useQuery({
    queryKey: ["events"],
    queryFn: async () => (await fetch("/api/events").then((r) => r.json())) as { events: Event[] },
    refetchInterval: autoRefresh ? 4000 : false,
  });
  const events = q.data?.events ?? [];

  // Auto-derive top 8 event types as filter chips (most useful for live tailing).
  const typeCounts = new Map<string, number>();
  for (const e of events) typeCounts.set(e.event_type, (typeCounts.get(e.event_type) ?? 0) + 1);
  const topTypes = Array.from(typeCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => k);

  const cols: Column<Event>[] = [
    { key: "created_at", header: "When", render: (e) => <span className="text-xs tabular-nums">{formatDateTime(e.created_at)}</span> },
    { key: "event_type", header: "Event", render: (e) => <Badge variant={badgeForType(e.event_type)}>{e.event_type}</Badge> },
    { key: "producer", header: "Producer", render: (e) => <span className="text-xs">{e.producer}</span> },
    { key: "entity_type", header: "Entity", render: (e) => <span className="text-xs">{e.entity_type}/{e.entity_id.slice(0, 8)}</span> },
    { key: "actor_id", header: "Actor", render: (e) => e.actor_id ? <span className="font-mono text-xs">{e.actor_id.slice(0, 8)}</span> : "—" },
    { key: "payload", header: "Payload", render: (e) => <span className="font-mono text-xs">{JSON.stringify(e.payload).slice(0, 100)}</span> },
  ];

  return (
    <>
      <PageHeader
        title="Event stream"
        description="Cross-module event bus (BRD §16). Live feed of every state change."
        icon={Activity}
        actions={
          <Button size="sm" variant={autoRefresh ? "default" : "secondary"} onClick={() => setAutoRefresh((v) => !v)}>
            <RefreshCw className="h-4 w-4" /> {autoRefresh ? "Live" : "Paused"}
          </Button>
        }
      />
      <DataView
        rows={events}
        columns={cols}
        rowKey={(e) => e.event_id}
        loading={q.isLoading}
        search={{ placeholder: "Search by entity / producer / event…", fields: ["event_type", "producer", "entity_type", "entity_id"] }}
        filters={[
          { key: "risk",    label: "Risk",       predicate: (e: Event) => e.event_type.startsWith("risk.") },
          { key: "payment", label: "Payments",   predicate: (e: Event) => e.event_type.startsWith("payment.") },
          { key: "checker", label: "Maker-checker", predicate: (e: Event) => e.event_type.startsWith("maker_checker") },
          { key: "auth",    label: "Auth",       predicate: (e: Event) => e.event_type.startsWith("auth.") },
          ...topTypes.slice(0, 4).map((t) => ({ key: `t-${t}`, label: t, predicate: (e: Event) => e.event_type === t })),
        ]}
        savedViewKey="events"
        refresh={() => q.refetch()}
        emptyTitle="No events yet"
        emptyDescription="Trigger any action — events propagate here within seconds."
      />
    </>
  );
}
