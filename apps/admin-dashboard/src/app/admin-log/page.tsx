"use client";

import { useQuery } from "@tanstack/react-query";
import { ScrollText } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatDateTime } from "@/lib/utils";

interface Event {
  event_id: string; tenant_id: string; actor_subject: string; actor_type: string;
  action: string; resource_type: string; resource_id: string; occurred_at: string; trace_id: string;
}

export default function AdminLogPage() {
  const q = useQuery({
    queryKey: ["admin-log"],
    queryFn: async () => (await fetch("/api/admin-log").then((r) => r.json())) as { events: Event[] },
  });
  const cols: Column<Event>[] = [
    { key: "occurred_at", header: "When", render: (r) => formatDateTime(r.occurred_at) },
    { key: "actor_subject", header: "Actor", render: (r) => `${r.actor_subject} (${r.actor_type})` },
    { key: "action", header: "Action" },
    { key: "resource_type", header: "Resource", render: (r) => `${r.resource_type}:${r.resource_id}` },
    { key: "trace_id", header: "Trace", render: (r) => r.trace_id ? <span className="font-mono text-xs">{r.trace_id.slice(0,8)}</span> : "—" },
  ];
  return (
    <>
      <PageHeader title="Admin log" description="Hash-chained audit trail of every state change." icon={ScrollText} />
      <Card><CardHeader><CardTitle>{(q.data?.events ?? []).length} events</CardTitle></CardHeader>
        <CardContent>
          <DataTable columns={cols} rows={q.data?.events ?? []} loading={q.isLoading} rowKey={(r) => r.event_id} emptyState="No audit events." />
        </CardContent>
      </Card>
    </>
  );
}
