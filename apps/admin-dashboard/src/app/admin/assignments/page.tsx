"use client";

import { useQuery } from "@tanstack/react-query";
import { UserPlus } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatDateTime } from "@/lib/utils";

interface Assignment {
  id: string; user_id: string; persona_kind: string; scope_id: string;
  scope_label: string; is_primary: boolean; granted_by: string; granted_at: string;
}

export default function AdminAssignmentsPage() {
  const q = useQuery({
    queryKey: ["admin:assignments"],
    queryFn: async () => (await fetch("/api/admin/assignments").then((r) => r.json())) as { assignments: Assignment[] },
  });
  const cols: Column<Assignment>[] = [
    { key: "user_id", header: "User", render: (r) => <span className="font-mono text-xs">{r.user_id.slice(0,8)}…</span> },
    { key: "persona_kind", header: "Persona", render: (r) => <Badge variant="brand">{r.persona_kind}</Badge> },
    { key: "scope_label", header: "Scope" },
    { key: "scope_id", header: "Scope ID", render: (r) => r.scope_id ? <span className="font-mono text-xs">{r.scope_id}</span> : "—" },
    { key: "is_primary", header: "Primary?", render: (r) => r.is_primary ? <Badge variant="success">yes</Badge> : <Badge variant="default">no</Badge> },
    { key: "granted_by", header: "Granted by", render: (r) => r.granted_by || "—" },
    { key: "granted_at", header: "When", render: (r) => formatDateTime(r.granted_at) },
  ];
  return (
    <>
      <PageHeader title="Assignments" description="Persona ↔ scope grants (PRODUCT_VISION §3.11)." icon={UserPlus} />
      <Card><CardHeader><CardTitle>{(q.data?.assignments ?? []).length} assignments</CardTitle></CardHeader>
        <CardContent><DataTable columns={cols} rows={q.data?.assignments ?? []} loading={q.isLoading} rowKey={(r) => r.id} emptyState="No assignments." /></CardContent>
      </Card>
    </>
  );
}
