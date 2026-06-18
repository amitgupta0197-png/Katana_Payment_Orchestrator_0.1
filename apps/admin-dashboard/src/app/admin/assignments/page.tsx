"use client";

// L1 — persona assignments. DataView with persona filter chips + search.

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { UserPlus, Plus } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import { DataView } from "@/components/world-class/data-view";
import { useCan } from "@/lib/use-access";
import { formatDateTime } from "@/lib/utils";

interface Assignment {
  id: string; user_id: string; persona_kind: string; scope_id: string;
  scope_label: string; is_primary: boolean; granted_by: string; granted_at: string;
}

export default function AdminAssignmentsPage() {
  const canCreate = useCan("assignments", "create");
  const q = useQuery({
    queryKey: ["admin:assignments"],
    queryFn: async () => (await fetch("/api/admin/assignments").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { assignments: Assignment[] },
  });
  const rows = q.data?.assignments ?? [];

  const cols: Column<Assignment>[] = [
    { key: "user_id", header: "User",
      render: (r) => <Link href={`/admin/users/${r.user_id}`} className="font-mono text-xs text-[color:var(--color-brand)] hover:underline">{r.user_id.slice(0, 8)}…</Link> },
    { key: "persona_kind", header: "Persona", render: (r) => <Badge variant="brand">{r.persona_kind}</Badge> },
    { key: "scope_label", header: "Scope", render: (r) => r.scope_label || "—" },
    { key: "scope_id", header: "Scope ID", render: (r) => r.scope_id ? <span className="font-mono text-xs">{r.scope_id}</span> : "—" },
    { key: "is_primary", header: "Primary", render: (r) => r.is_primary ? <Badge variant="success">yes</Badge> : <Badge variant="default">no</Badge> },
    { key: "granted_by", header: "Granted by", render: (r) => r.granted_by || "—" },
    { key: "granted_at", header: "When", render: (r) => <span className="text-xs">{formatDateTime(r.granted_at)}</span> },
  ];

  return (
    <>
      <PageHeader
        title="Assignments"
        description="Persona ↔ scope grants (PRODUCT_VISION §3.11). Manage via /admin/access add-user dialog."
        icon={UserPlus}
        actions={canCreate ? (
          <Button asChild><Link href="/admin/access?new=1"><Plus className="h-4 w-4" /> Add assignment</Link></Button>
        ) : null}
      />
      <DataView
        rows={rows}
        columns={cols}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        search={{ placeholder: "Search by user id, scope, granter…", fields: ["user_id", "scope_id", "scope_label", "granted_by"] }}
        filters={[
          { key: "super",   label: "SUPER_ADMIN", predicate: (r: Assignment) => r.persona_kind === "SUPER_ADMIN" },
          { key: "prov",    label: "PROVIDER",    predicate: (r: Assignment) => r.persona_kind === "PROVIDER" },
          { key: "merch",   label: "MERCHANT",    predicate: (r: Assignment) => r.persona_kind === "MERCHANT" },
          { key: "primary", label: "Primary only", predicate: (r: Assignment) => r.is_primary },
        ]}
        savedViewKey="admin-assignments"
        refresh={() => q.refetch()}
        emptyTitle="No assignments yet"
        emptyDescription="Grant a persona to a user from /admin/access — the add-user dialog covers both in one step."
      />
    </>
  );
}
