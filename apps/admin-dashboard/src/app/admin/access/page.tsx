"use client";

// Access matrix UI — SUPER_ADMIN edits cells in-place; PROVIDER/MERCHANT see
// their own row read-only. Add User form lives in a dialog on this page so
// onboarding a user + scoping them happens in one place.

import { Fragment, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Shield, UserPlus, Plus } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";

type Persona = "SUPER_ADMIN" | "PROVIDER" | "MERCHANT";
type OpCol = "can_create" | "can_read" | "can_update" | "can_delete" | "can_admin";

interface ModuleMeta { module_code: string; display_name: string; area: string; description: string }
interface MatrixCell {
  module_code: string; display_name: string; area: string; persona: Persona;
  can_create: boolean; can_read: boolean; can_update: boolean; can_delete: boolean; can_admin: boolean;
  updated_at: string; updated_by: string;
}
interface MatrixResp { modules: ModuleMeta[]; matrix: MatrixCell[] }

const PERSONAS: Persona[] = ["SUPER_ADMIN", "PROVIDER", "MERCHANT"];
const OPS: { key: OpCol; label: string }[] = [
  { key: "can_create", label: "C" },
  { key: "can_read",   label: "R" },
  { key: "can_update", label: "U" },
  { key: "can_delete", label: "D" },
  { key: "can_admin",  label: "A" },
];

function AddUserDialog() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    email: "newuser@katana.dev",
    full_name: "New User",
    persona: "MERCHANT" as Persona,
    scope_id: "",
    scope_label: "",
  });
  const m = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        email: form.email, full_name: form.full_name, persona: form.persona,
        scope_label: form.scope_label,
      };
      if (form.persona !== "SUPER_ADMIN") payload.scope_id = form.scope_id;
      const r = await fetch("/api/admin/access/users", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json();
    },
    onSuccess: () => {
      toast.success("User added");
      qc.invalidateQueries({ queryKey: ["admin:users"] });
      qc.invalidateQueries({ queryKey: ["admin:assignments"] });
      setOpen(false);
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Plus /> Add user</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add user</DialogTitle>
          <DialogDescription>Creates the user and grants one initial persona.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5 col-span-2">
            <Label>Email</Label>
            <Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div className="space-y-1.5 col-span-2">
            <Label>Full name</Label>
            <Input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>Persona</Label>
            <select
              className="h-10 w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-3 text-sm"
              value={form.persona}
              onChange={(e) => setForm({ ...form, persona: e.target.value as Persona })}
            >
              {PERSONAS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          {form.persona !== "SUPER_ADMIN" && (
            <div className="space-y-1.5">
              <Label>Scope ID</Label>
              <Input
                placeholder={form.persona === "PROVIDER" ? "provider uuid" : "merchant code"}
                value={form.scope_id}
                onChange={(e) => setForm({ ...form, scope_id: e.target.value })}
              />
            </div>
          )}
          <div className="space-y-1.5 col-span-2">
            <Label>Scope label (optional)</Label>
            <Input
              placeholder="e.g. Acme Payments — Mumbai"
              value={form.scope_label}
              onChange={(e) => setForm({ ...form, scope_label: e.target.value })}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={() => m.mutate()} disabled={m.isPending}>{m.isPending ? "Adding…" : "Add"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PermCheckbox({
  checked, disabled, onChange,
}: { checked: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      className="h-4 w-4 cursor-pointer accent-[color:var(--color-brand)] disabled:cursor-not-allowed disabled:opacity-50"
    />
  );
}

export default function AccessMatrixPage() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["admin:access"],
    queryFn: async () => (await fetch("/api/admin/access").then((r) => r.json())) as MatrixResp,
  });
  const meQ = useQuery({
    queryKey: ["me:access"],
    queryFn: async () => (await fetch("/api/me/access").then((r) => r.json())) as { persona: Persona },
  });

  const cellMap = useMemo(() => {
    const map = new Map<string, MatrixCell>();
    for (const c of q.data?.matrix ?? []) map.set(`${c.module_code}|${c.persona}`, c);
    return map;
  }, [q.data]);

  const isSuper = meQ.data?.persona === "SUPER_ADMIN";

  const m = useMutation({
    mutationFn: async (patch: { module_code: string; persona: Persona } & Partial<Record<OpCol, boolean>>) => {
      const r = await fetch("/api/admin/access", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json();
    },
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: ["admin:access"] });
      const prev = qc.getQueryData<MatrixResp>(["admin:access"]);
      qc.setQueryData<MatrixResp>(["admin:access"], (old) => {
        if (!old) return old;
        return {
          ...old,
          matrix: old.matrix.map((c) =>
            c.module_code === patch.module_code && c.persona === patch.persona
              ? { ...c, ...patch }
              : c,
          ),
        };
      });
      return { prev };
    },
    onError: (e: Error, _v, ctx) => {
      toast.error("Failed", { description: e.message });
      if (ctx?.prev) qc.setQueryData(["admin:access"], ctx.prev);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me:access"] }),
  });

  const modules = q.data?.modules ?? [];
  const byArea = useMemo(() => {
    const groups = new Map<string, ModuleMeta[]>();
    for (const m of modules) {
      const a = groups.get(m.area) ?? [];
      a.push(m); groups.set(m.area, a);
    }
    return Array.from(groups.entries());
  }, [modules]);

  return (
    <>
      <PageHeader
        title="Access matrix"
        description="Persona × module CRUD-Admin. SUPER_ADMIN edits cells; flips propagate to lib/access.ts in real time."
        icon={Shield}
        actions={isSuper ? <AddUserDialog /> : null}
      />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {modules.length} modules
            {!isSuper && meQ.data?.persona && (
              <Badge variant="info" className="ml-2">
                <UserPlus className="h-3 w-3 mr-1 inline" />read-only as {meQ.data.persona}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {q.isLoading ? (
            <div className="py-8 text-center text-sm text-[color:var(--color-text-muted)]">Loading…</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[color:var(--color-border)] text-left text-xs uppercase tracking-wide text-[color:var(--color-text-muted)]">
                    <th className="py-2 pr-4">Module</th>
                    {PERSONAS.flatMap((p) =>
                      OPS.map((op) => (
                        <th key={`${p}-${op.key}`} className="px-1 py-2 text-center" title={`${p} · ${op.key}`}>
                          <div className="text-[10px] font-medium">{p === "SUPER_ADMIN" ? "SA" : p[0]}</div>
                          <div className="text-[10px]">{op.label}</div>
                        </th>
                      )),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {byArea.map(([area, mods]) => (
                    <Fragment key={`area-${area}`}>
                      <tr className="bg-[color:var(--color-surface-muted)]">
                        <td colSpan={1 + PERSONAS.length * OPS.length} className="py-1.5 px-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">
                          {area}
                        </td>
                      </tr>
                      {mods.map((mod) => (
                        <tr key={mod.module_code} className="border-b border-[color:var(--color-border)] last:border-0 hover:bg-[color:var(--color-surface-muted)]/50">
                          <td className="py-2 pr-4">
                            <div className="font-medium">{mod.display_name}</div>
                            <div className="text-xs text-[color:var(--color-text-muted)] font-mono">{mod.module_code}</div>
                          </td>
                          {PERSONAS.map((persona) => {
                            const cell = cellMap.get(`${mod.module_code}|${persona}`);
                            return OPS.map((op) => {
                              const checked = cell ? cell[op.key] : false;
                              const editable = isSuper && !!cell;
                              return (
                                <td key={`${mod.module_code}-${persona}-${op.key}`} className="px-1 py-2 text-center">
                                  <PermCheckbox
                                    checked={checked}
                                    disabled={!editable || m.isPending}
                                    onChange={(v) => m.mutate({ module_code: mod.module_code, persona, [op.key]: v })}
                                  />
                                </td>
                              );
                            });
                          })}
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
