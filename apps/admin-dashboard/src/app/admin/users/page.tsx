"use client";

// L1 — admin/users. DataView with status filter chips, search, row kebab
// linking to L3 detail and exposing Suspend / Disable / Re-enable. Add-user
// flow lives on /admin/access (same dialog).

import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserCog, Pause, Play, Trash2, ExternalLink, Plus } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import { DataView } from "@/components/world-class/data-view";
import { RowActions } from "@/components/world-class/row-actions";
import { useCan } from "@/lib/use-access";
import { formatDateTime, statusVariant } from "@/lib/utils";

interface User { id: string; email: string; full_name: string; status: string; created_at: string; updated_at: string }

export default function AdminUsersPage() {
  const qc = useQueryClient();
  const canCreate = useCan("users", "create");
  const canUpdate = useCan("users", "update");
  const canDelete = useCan("users", "delete");

  const q = useQuery({
    queryKey: ["admin:users"],
    queryFn: async () => (await fetch("/api/admin/users").then((r) => r.json())) as { users: User[] },
  });

  const patch = useMutation({
    mutationFn: async ({ id, status, notes }: { id: string; status: string; notes: string }) => {
      const r = await fetch(`/api/admin/users/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status, notes }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json();
    },
    onSuccess: (_, v) => { toast.success(`User → ${v.status}`); qc.invalidateQueries({ queryKey: ["admin:users"] }); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const users = q.data?.users ?? [];

  const cols: Column<User>[] = [
    { key: "email", header: "Email",
      render: (r) => <Link href={`/admin/users/${r.id}`} className="text-[color:var(--color-brand)] hover:underline font-medium">{r.email}</Link> },
    { key: "full_name", header: "Name", render: (r) => r.full_name || "—" },
    { key: "status", header: "Status",
      render: (r) => <Badge variant={statusVariant(r.status === "active" ? "ACTIVE" : r.status === "suspended" ? "SUSPENDED" : "DISABLED")}>{r.status}</Badge> },
    { key: "created_at", header: "Created", render: (r) => <span className="text-xs">{formatDateTime(r.created_at)}</span> },
    { key: "updated_at", header: "Updated", render: (r) => <span className="text-xs">{formatDateTime(r.updated_at)}</span> },
  ];

  return (
    <>
      <PageHeader
        title="Users"
        description="Platform users — open a user to manage personas, status, and impersonation (PRODUCT_VISION §3.11)."
        icon={UserCog}
        actions={canCreate ? (
          <Button asChild><Link href="/admin/access?new=1"><Plus className="h-4 w-4" /> Add user</Link></Button>
        ) : null}
      />
      <DataView
        rows={users}
        columns={cols}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        href={(r) => `/admin/users/${r.id}`}
        search={{ placeholder: "Search by email or name…", fields: ["email", "full_name"] }}
        filters={[
          { key: "active",    label: "Active",    predicate: (r: User) => r.status === "active" },
          { key: "suspended", label: "Suspended", predicate: (r: User) => r.status === "suspended" },
          { key: "disabled",  label: "Disabled",  predicate: (r: User) => r.status === "disabled" },
        ]}
        savedViewKey="admin-users"
        refresh={() => q.refetch()}
        emptyTitle="No users yet"
        emptyDescription="Add the first user from /admin/access — grant a persona at the same time."
        rowActions={(r) => (
          <RowActions
            openHref={`/admin/users/${r.id}`}
            actions={[
              { label: "Open detail", icon: ExternalLink, onClick: () => (window.location.href = `/admin/users/${r.id}`) },
              ...(canUpdate && r.status === "active" ? [{ label: "Suspend", icon: Pause, onClick: () => patch.mutate({ id: r.id, status: "suspended", notes: "suspended from list" }) }] : []),
              ...(canUpdate && r.status === "suspended" ? [{ label: "Reactivate", icon: Play, onClick: () => patch.mutate({ id: r.id, status: "active", notes: "reactivated from list" }) }] : []),
              ...(canDelete && r.status !== "disabled" ? [{
                label: "Disable", icon: Trash2, variant: "danger" as const,
                onClick: () => { if (confirm(`Disable ${r.email}?`)) patch.mutate({ id: r.id, status: "disabled", notes: "disabled from list" }); },
              }] : []),
            ]}
          />
        )}
      />
    </>
  );
}
