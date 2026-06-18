"use client";

import { useQuery } from "@tanstack/react-query";
import { UserCog } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatDateTime, statusVariant } from "@/lib/utils";

interface User { id: string; email: string; full_name: string; status: string; created_at: string; updated_at: string }

export default function AdminUsersPage() {
  const q = useQuery({
    queryKey: ["admin:users"],
    queryFn: async () => (await fetch("/api/admin/users").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { users: User[] },
  });
  const cols: Column<User>[] = [
    { key: "email", header: "Email" },
    { key: "full_name", header: "Name" },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status === "active" ? "ACTIVE" : "SUSPENDED")}>{r.status}</Badge> },
    { key: "created_at", header: "Created", render: (r) => formatDateTime(r.created_at) },
    { key: "updated_at", header: "Updated", render: (r) => formatDateTime(r.updated_at) },
  ];
  return (
    <>
      <PageHeader title="Users" description="Platform users — invite / disable / impersonate (PRODUCT_VISION §3.11)." icon={UserCog} />
      <Card><CardHeader><CardTitle>{(q.data?.users ?? []).length} users</CardTitle></CardHeader>
        <CardContent><DataTable columns={cols} rows={q.data?.users ?? []} loading={q.isLoading} rowKey={(r) => r.id} emptyState="No users." /></CardContent>
      </Card>
    </>
  );
}
