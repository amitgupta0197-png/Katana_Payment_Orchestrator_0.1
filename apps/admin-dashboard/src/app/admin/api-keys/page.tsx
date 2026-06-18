"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Trash2, Ban } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatDateTime, statusVariant } from "@/lib/utils";

interface ApiKey {
  id: string; label: string; owner_kind: string; owner_id: string; prefix: string;
  scopes: string[]; status: string; created_at: string; last_used_at?: string; revoked_at?: string;
}

function KeyActions({ k }: { k: ApiKey }) {
  const qc = useQueryClient();
  const revoke = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/admin/api-keys/${k.id}`, { method: "PATCH" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json();
    },
    onSuccess: () => { toast.success("Key revoked"); qc.invalidateQueries({ queryKey: ["admin:api-keys"] }); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });
  const del = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/admin/api-keys/${k.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json();
    },
    onSuccess: () => { toast.success("Key deleted"); qc.invalidateQueries({ queryKey: ["admin:api-keys"] }); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });
  return (
    <div className="flex gap-2">
      {k.status === "ACTIVE" && (
        <Button size="sm" variant="secondary" onClick={() => revoke.mutate()} disabled={revoke.isPending}>
          <Ban className="h-4 w-4" /> Revoke
        </Button>
      )}
      <Button size="sm" variant="danger" onClick={() => { if (confirm(`Delete key '${k.label}'?`)) del.mutate(); }} disabled={del.isPending}>
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  );
}

export default function AdminApiKeysPage() {
  const q = useQuery({
    queryKey: ["admin:api-keys"],
    queryFn: async () => (await fetch("/api/admin/api-keys").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { keys: ApiKey[] },
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
    { key: "actions", header: "", render: (r) => <KeyActions k={r} /> },
  ];
  return (
    <>
      <PageHeader title="API keys" description="Platform-wide API keys. Revoke disables the key (cannot un-revoke); Delete removes the row." icon={KeyRound} />
      <Card><CardHeader><CardTitle>{(q.data?.keys ?? []).length} keys</CardTitle></CardHeader>
        <CardContent><DataTable columns={cols} rows={q.data?.keys ?? []} loading={q.isLoading} rowKey={(r) => r.id} emptyState="No keys." /></CardContent>
      </Card>
    </>
  );
}
