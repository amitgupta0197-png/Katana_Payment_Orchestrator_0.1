"use client";

import { useQuery } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatDateTime, statusVariant } from "@/lib/utils";

interface ApiKey {
  id: string; label: string; owner_kind: string; owner_id: string; prefix: string;
  scopes: string[]; status: string; created_at: string; last_used_at?: string; revoked_at?: string;
}

export default function AdminApiKeysPage() {
  const q = useQuery({
    queryKey: ["admin:api-keys"],
    queryFn: async () => (await fetch("/api/admin/api-keys").then((r) => r.json())) as { keys: ApiKey[] },
  });
  const cols: Column<ApiKey>[] = [
    { key: "label", header: "Label" },
    { key: "owner_kind", header: "Owner kind" },
    { key: "owner_id", header: "Owner ID", render: (r) => <span className="font-mono text-xs">{r.owner_id}</span> },
    { key: "prefix", header: "Prefix", render: (r) => <span className="font-mono text-xs">{r.prefix}…</span> },
    { key: "scopes", header: "Scopes", render: (r) => (r.scopes ?? []).join(", ") || "—" },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "created_at", header: "Created", render: (r) => formatDateTime(r.created_at) },
    { key: "last_used_at", header: "Last used", render: (r) => r.last_used_at ? formatDateTime(r.last_used_at) : "—" },
  ];
  return (
    <>
      <PageHeader title="API keys" description="Platform-wide API keys (admin view)." icon={KeyRound} />
      <Card><CardHeader><CardTitle>{(q.data?.keys ?? []).length} keys</CardTitle></CardHeader>
        <CardContent><DataTable columns={cols} rows={q.data?.keys ?? []} loading={q.isLoading} rowKey={(r) => r.id} emptyState="No keys." /></CardContent>
      </Card>
    </>
  );
}
