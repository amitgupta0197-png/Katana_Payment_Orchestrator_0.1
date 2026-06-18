"use client";

// L3 — user detail. DetailShell with tabs (Overview / Personas / Activity /
// Danger). Sticky right rail exposes Disable / Suspend / Reactivate /
// Reset password (stub) / Impersonate (stub). Fills the audit P0 "users
// list says invite/disable/impersonate but the page has none of that".

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  UserCog, ShieldCheck, Activity, AlertOctagon, Pause, Play, KeyRound,
  UserCheck, Trash2, Mail,
} from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type Column } from "@/components/ui/data-table";
import { DetailShell } from "@/components/world-class/detail-shell";
import { ActivityFeed } from "@/components/world-class/activity-feed";
import { InlineEdit } from "@/components/world-class/inline-edit";
import { EmptyState } from "@/components/world-class/empty-state";
import { formatDateTime, statusVariant } from "@/lib/utils";

interface User {
  id: string; email: string; full_name: string;
  status: "active" | "suspended" | "disabled";
  created_at: string; updated_at: string;
}
interface Persona {
  id: string; persona_kind: string; scope_id: string; scope_label: string;
  is_primary: boolean; granted_by: string; granted_at: string;
}

export default function UserDetailView({ id }: { id: string }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["admin:user", id],
    queryFn: async () => (await fetch(`/api/admin/users/${id}`).then((r) => r.json())) as { user: User; personas: Persona[] },
  });

  const patch = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const r = await fetch(`/api/admin/users/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin:user", id] });
      qc.invalidateQueries({ queryKey: ["admin:users"] });
      qc.invalidateQueries({ queryKey: ["activity", "user", id] });
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const setStatus = (status: "active" | "suspended" | "disabled", note: string) => {
    patch.mutate({ status, notes: note }, {
      onSuccess: () => toast.success(`User ${status}`),
    });
  };

  if (q.isLoading) return <Card><CardContent className="py-8 text-center text-sm">Loading…</CardContent></Card>;
  if (q.error || !q.data?.user) {
    return <EmptyState icon={UserCog} title="User not found" description="The user may have been deleted." secondaryAction={{ label: "Back to users", href: "/admin/users" }} />;
  }

  const { user, personas } = q.data;
  const isActive = user.status === "active";
  const isSuspended = user.status === "suspended";
  const isDisabled = user.status === "disabled";

  const personaCols: Column<Persona>[] = [
    { key: "persona_kind", header: "Persona", render: (r) => <Badge variant="brand">{r.persona_kind}</Badge> },
    { key: "scope_label", header: "Scope", render: (r) => r.scope_label || "—" },
    { key: "scope_id", header: "Scope ID", render: (r) => r.scope_id ? <span className="font-mono text-xs">{r.scope_id}</span> : "—" },
    { key: "is_primary", header: "Primary", render: (r) => r.is_primary ? <Badge variant="success">yes</Badge> : <Badge variant="default">no</Badge> },
    { key: "granted_by", header: "Granted by", render: (r) => r.granted_by || "—" },
    { key: "granted_at", header: "When", render: (r) => formatDateTime(r.granted_at) },
  ];

  const tabs = [
    { key: "overview", label: "Overview", icon: UserCog, content: (
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">Identity</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[color:var(--color-text-muted)]">Email</span>
              <span className="font-mono">{user.email}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[color:var(--color-text-muted)]">Full name</span>
              <InlineEdit
                value={user.full_name}
                onSave={async (next) => { await patch.mutateAsync({ full_name: next, notes: "inline edit: full_name" }); }}
              />
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[color:var(--color-text-muted)]">Status</span>
              <Badge variant={statusVariant(user.status.toUpperCase())}>{user.status}</Badge>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[color:var(--color-text-muted)]">Created</span>
              <span>{formatDateTime(user.created_at)}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[color:var(--color-text-muted)]">Last updated</span>
              <span>{formatDateTime(user.updated_at)}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[color:var(--color-text-muted)]">User ID</span>
              <span className="font-mono text-xs">{user.id}</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Personas ({personas.length})</CardTitle>
            <CardDescription>Active persona assignments — primary determines default scope on login.</CardDescription>
          </CardHeader>
          <CardContent>
            {personas.length === 0
              ? <EmptyState icon={ShieldCheck} title="No personas granted" description="Grant via /admin/access — until then this user can authenticate but has no scope." />
              : <div className="flex flex-col gap-2">
                  {personas.map((p) => (
                    <div key={p.id} className="flex items-center gap-2 rounded-md border p-2">
                      <Badge variant="brand">{p.persona_kind}</Badge>
                      <span className="flex-1 truncate text-sm">{p.scope_label || "—"}</span>
                      {p.is_primary && <Badge variant="success">primary</Badge>}
                    </div>
                  ))}
                </div>}
          </CardContent>
        </Card>
      </div>
    )},
    { key: "personas", label: "Personas", icon: ShieldCheck, count: personas.length, content: (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">All persona assignments</CardTitle>
          <CardDescription>Manage at <a className="text-[color:var(--color-brand)] hover:underline" href="/admin/access">/admin/access</a>.</CardDescription>
        </CardHeader>
        <CardContent>
          {personas.length === 0
            ? <EmptyState icon={ShieldCheck} title="No personas" description="Use Add User in the access matrix to grant one." />
            : <DataTable columns={personaCols} rows={personas} rowKey={(r) => r.id} />}
        </CardContent>
      </Card>
    )},
    { key: "activity", label: "Activity", icon: Activity, content: (
      <ActivityFeed resourceType="user" resourceId={id} />
    )},
    { key: "danger", label: "Danger zone", icon: AlertOctagon, content: (
      <Card>
        <CardHeader>
          <CardTitle className="text-base text-[color:var(--color-danger)]">Disable user</CardTitle>
          <CardDescription>Disabled users cannot log in. Sessions are revoked on next refresh.</CardDescription>
        </CardHeader>
        <CardContent>
          {isDisabled ? (
            <div className="flex items-center justify-between gap-3 rounded-md border p-3">
              <span className="text-sm">User is currently <Badge variant="danger">disabled</Badge></span>
              <Button variant="secondary" onClick={() => setStatus("active", "re-enable from danger zone")}><Play className="h-4 w-4" /> Re-enable</Button>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3 rounded-md border border-[color:var(--color-danger)]/30 bg-[color:var(--color-danger-muted)]/30 p-3">
              <div>
                <div className="text-sm font-medium">Disable {user.email}</div>
                <div className="text-xs text-[color:var(--color-text-muted)]">Reversible — re-enable from this page.</div>
              </div>
              <Button variant="danger" onClick={() => { if (confirm(`Disable ${user.email}?`)) setStatus("disabled", "disabled from danger zone"); }}>
                <Trash2 className="h-4 w-4" /> Disable
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    )},
  ];

  return (
    <DetailShell
      breadcrumbs={[{ label: "Admin", href: "/admin/users" }, { label: "Users", href: "/admin/users" }, { label: user.email }]}
      backHref="/admin/users"
      title={user.full_name || user.email}
      subtitle={user.full_name ? user.email : undefined}
      status={{ label: user.status, variant: statusVariant(user.status.toUpperCase()) }}
      meta={
        <div className="flex flex-wrap items-center gap-2 text-sm text-[color:var(--color-text-muted)]">
          <Badge variant="info">{personas.length} persona{personas.length === 1 ? "" : "s"}</Badge>
          <span>·</span><span>created {formatDateTime(user.created_at)}</span>
        </div>
      }
      sideActions={[
        isActive ? { label: "Suspend", icon: Pause, variant: "secondary" as const, onClick: () => setStatus("suspended", "suspended via UI"), loading: patch.isPending } : null,
        isSuspended ? { label: "Reactivate", icon: Play, onClick: () => setStatus("active", "reactivated via UI"), loading: patch.isPending } : null,
        { label: "Reset password", icon: KeyRound, variant: "secondary" as const, onClick: () => toast.info("Password reset email wiring lands with notifications service") },
        { label: "Send invite email", icon: Mail, variant: "secondary" as const, onClick: () => toast.info("Invite flow lands with notifications service") },
        { label: "Impersonate", icon: UserCheck, variant: "secondary" as const, onClick: () => toast.info("Impersonation requires session-mint endpoint — not yet shipped") },
      ].filter(Boolean) as []}
      tabs={tabs}
    />
  );
}
