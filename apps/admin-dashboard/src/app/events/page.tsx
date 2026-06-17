"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatDateTime } from "@/lib/utils";

interface Event {
  event_id: string; event_type: string; producer: string;
  entity_type: string; entity_id: string; actor_id?: string;
  payload: Record<string, unknown>; created_at: string;
}

const EVENT_TYPES = [
  "", "merchant.created", "submid.status_changed", "payment.created",
  "route.selected", "callback.received", "payment.succeeded",
  "settlement.calculated", "reconciliation.break_opened", "risk.alert",
  "provider.kyc_decided", "maker_checker.requested", "maker_checker.decided",
  "auth.session_started", "auth.session_ended",
];

function badgeForType(t: string): "brand" | "success" | "warning" | "danger" | "default" {
  if (t.startsWith("payment.succeeded") || t.endsWith(".decided")) return "success";
  if (t.startsWith("risk.") || t.includes("break")) return "danger";
  if (t.startsWith("maker_checker")) return "warning";
  return "brand";
}

export default function EventsPage() {
  const [type, setType] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);

  const q = useQuery({
    queryKey: ["events", type],
    queryFn: async () =>
      (await fetch(`/api/events${type ? `?type=${encodeURIComponent(type)}` : ""}`).then((r) => r.json())) as { events: Event[] },
    refetchInterval: autoRefresh ? 4000 : false,
  });

  const cols: Column<Event>[] = [
    { key: "created_at", header: "When", render: (e) => formatDateTime(e.created_at) },
    { key: "event_type", header: "Event", render: (e) => <Badge variant={badgeForType(e.event_type)}>{e.event_type}</Badge> },
    { key: "producer", header: "Producer", render: (e) => <span className="text-xs">{e.producer}</span> },
    { key: "entity_type", header: "Entity", render: (e) => `${e.entity_type}/${e.entity_id}` },
    { key: "actor_id", header: "Actor", render: (e) => e.actor_id ? <span className="font-mono text-xs">{e.actor_id.slice(0, 8)}</span> : "—" },
    { key: "payload", header: "Payload", render: (e) => <span className="font-mono text-xs">{JSON.stringify(e.payload).slice(0, 120)}</span> },
  ];

  return (
    <>
      <PageHeader
        title="Event stream"
        description="Cross-module event bus (BRD §16). Live feed of every state change."
        icon={Activity}
        actions={
          <div className="flex items-center gap-2">
            <select
              className="flex h-9 rounded-md border px-3 py-1 text-sm bg-[color:var(--color-surface)]"
              value={type} onChange={(e) => setType(e.target.value)}
            >
              {EVENT_TYPES.map((t) => <option key={t} value={t}>{t || "All event types"}</option>)}
            </select>
            <Button size="sm" variant={autoRefresh ? "default" : "secondary"} onClick={() => setAutoRefresh((v) => !v)}>
              <RefreshCw className="h-4 w-4" /> {autoRefresh ? "Live" : "Paused"}
            </Button>
          </div>
        }
      />
      <Card>
        <CardHeader>
          <CardTitle>{(q.data?.events ?? []).length} events</CardTitle>
          <CardDescription>
            {autoRefresh ? "Auto-refreshing every 4 seconds." : "Refresh paused. Click Live to resume."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={cols}
            rows={q.data?.events ?? []}
            loading={q.isLoading}
            rowKey={(e) => e.event_id}
            emptyState="No events yet. Try logging out and back in, then refresh."
          />
        </CardContent>
      </Card>
    </>
  );
}
