"use client";

import { useQuery } from "@tanstack/react-query";
import { Shield } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";

interface Role { code: string; scope: string; permissions: string[]; description: string }

export default function AdminRolesPage() {
  const q = useQuery({
    queryKey: ["admin:roles"],
    queryFn: async () => (await fetch("/api/admin/roles").then((r) => r.json())) as { roles: Role[] },
  });
  const cols: Column<Role>[] = [
    { key: "code", header: "Role" },
    { key: "scope", header: "Scope", render: (r) => <Badge variant="brand">{r.scope}</Badge> },
    { key: "permissions", header: "Permissions", render: (r) => <span className="text-xs font-mono">{r.permissions.join(", ")}</span> },
    { key: "description", header: "Description" },
  ];
  return (
    <>
      <PageHeader title="Roles & permissions" description="RBAC roles per persona + scope (PRODUCT_VISION §1.1)." icon={Shield} />
      <Card><CardHeader><CardTitle>{(q.data?.roles ?? []).length} roles</CardTitle></CardHeader>
        <CardContent><DataTable columns={cols} rows={q.data?.roles ?? []} loading={q.isLoading} rowKey={(r) => r.code} emptyState="No roles." /></CardContent>
      </Card>
    </>
  );
}
