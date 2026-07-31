"use client";

// L1 — RBAC roles catalogue (read-only). DataView with scope filter chips.

import { useQuery } from "@tanstack/react-query";
import { Shield } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import { DataView } from "@/components/world-class/data-view";

interface Role { code: string; scope: string; permissions: string[]; description: string }

export default function AdminRolesPage() {
  const q = useQuery({
    queryKey: ["admin:roles"],
    queryFn: async () => (await fetch("/api/admin/roles").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { roles: Role[] },
  });
  const rows = q.data?.roles ?? [];

  const cols: Column<Role>[] = [
    { key: "code", header: "Role", render: (r) => <span className="font-mono text-xs">{r.code}</span> },
    { key: "scope", header: "Scope", render: (r) => <Badge variant="brand">{r.scope}</Badge> },
    { key: "permissions", header: "Permissions", render: (r) => <span className="text-xs font-mono">{r.permissions.join(", ")}</span> },
    { key: "description", header: "Description" },
  ];

  return (
    <>
      <PageHeader title="Roles & permissions" description="RBAC roles per persona + scope (PRODUCT_VISION §1.1)." icon={Shield} />
      <DataView rows={rows} columns={cols} rowKey={(r) => r.code} loading={q.isLoading}
        search={{ placeholder: "Search by role / permission…", fields: ["code", "description"] }}
        filters={[
          { key: "platform", label: "Platform", predicate: (r: Role) => r.scope === "platform-wide" },
          { key: "provider", label: "Provider", predicate: (r: Role) => r.scope === "provider" },
          { key: "merchant", label: "Branch", predicate: (r: Role) => r.scope === "merchant" },
        ]}
        savedViewKey="admin-roles" refresh={() => q.refetch()}
        emptyTitle="No roles defined" />
    </>
  );
}
