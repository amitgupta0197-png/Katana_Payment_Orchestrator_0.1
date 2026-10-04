"use client";

// One master record (/mdm/{type}/{id}): core fields read-only (edited on the record's own page),
// custom fields editable (SUPER_ADMIN / ADMIN; a field marked for approval goes to Maker-Checker),
// the Relationship Map and the change history. Staff only.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ExternalLink, History } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { MASTERS, buildFormSchema, type MasterType } from "@/lib/mdm";
import type { MasterRecord } from "@/lib/mdm-store";
import { FieldForm } from "./field-form";
import { RelationshipMap } from "./relationship-map";
import { TYPE_ICON, fmtTime, fmtValue, muted, readJson, slug } from "./shared";

const KIND_LABEL: Record<string, string> = {
  EXTRA_SET: "Value set", EXTRA_PROPOSED: "Sent for approval", EXTRA_REJECTED: "Rejected",
  TEMPLATE_PROPOSED: "Template proposed", TEMPLATE_APPLIED: "Template applied", TEMPLATE_REJECTED: "Template rejected",
};

export function RecordView({ type, id }: { type: MasterType; id: string }) {
  const m = MASTERS[type];
  const qc = useQueryClient();
  const router = useRouter();
  // The same persona query as the menu (components/layout/use-nav); the API enforces it anyway.
  const me = useQuery({
    queryKey: ["me:persona"],
    queryFn: async () => (await fetch("/api/auth/me").then((r) => r.json())) as { persona: string },
    staleTime: 5 * 60_000,
  });
  const canEdit = ["SUPER_ADMIN", "ADMIN"].includes(String(me.data?.persona ?? ""));
  const q = useQuery({ queryKey: ["mdm", "record", type, id], queryFn: async () => readJson<MasterRecord>(await fetch(`/api/mdm/${slug(type)}/${id}`)) });

  const save = useMutation({
    mutationFn: async (values: Record<string, unknown>) => readJson<{ applied: unknown[]; pending: unknown[]; request_id: string | null }>(
      await fetch(`/api/mdm/${slug(type)}/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values }) })),
    onSuccess: (r) => {
      if (r.request_id) toast.success(`${r.applied.length ? "Saved; " : ""}${r.pending.length} change${r.pending.length === 1 ? "" : "s"} sent for approval`, {
        action: { label: "Open Maker-Checker", onClick: () => router.push("/admin/maker-checker") },
      });
      else toast.success(r.applied.length ? "Custom fields saved" : "Nothing changed");
      qc.invalidateQueries({ queryKey: ["mdm"] });
    },
    onError: (e: Error & { body?: any }) => {
      const errs = e.body?.errors as Record<string, string> | undefined;
      toast.error("Could not save", { description: errs ? Object.entries(errs).map(([k, v]) => `${k} ${v}`).join("; ") : e.message });
    },
  });

  if (q.isLoading) return <p className={`text-sm ${muted}`}>Loading…</p>;
  if (q.error || !q.data) return <p className="text-sm text-[color:var(--color-danger)]">{(q.error as Error)?.message ?? "Not found"}</p>;
  const r = q.data;
  const sections = buildFormSchema(r.fields, { core: r.core, extra: r.extra });
  const Icon = TYPE_ICON[type];

  return (
    <div className="space-y-4">
      <PageHeader title={r.title} icon={Icon} description={`${m.label} · template v${r.version}`}
        actions={<>
          <Button asChild variant="secondary"><Link href={r.edit_href}><ExternalLink className="h-4 w-4" /> Edit on its page</Link></Button>
          <Button asChild variant="ghost"><Link href={`/mdm/${slug(type)}`}>All {m.plural.toLowerCase()}</Link></Button>
        </>} />

      {r.pending_extra && (
        <div className="rounded-lg border border-[color:var(--color-warning)]/40 bg-[color:var(--color-warning-muted)] p-3 text-sm">
          <div className="font-medium">Awaiting approval: {Object.entries(r.pending_extra.values).map(([k, v]) => `${k} → ${fmtValue(v)}`).join(", ")}</div>
          <div className={muted}>by {r.pending_extra.maker_email} · {fmtTime(r.pending_extra.created_at)} · <Link className="text-[color:var(--color-brand)] hover:underline" href="/admin/maker-checker">Open Maker-Checker</Link></div>
        </div>
      )}

      <Card>
        <CardHeader><CardTitle>Fields</CardTitle></CardHeader>
        <CardContent>
          <p className={`mb-4 text-sm ${muted}`}>Core fields are edited on the {m.label.toLowerCase()}&apos;s own page. Custom fields are kept here.</p>
          <FieldForm key={JSON.stringify(r.extra) + r.version} fields={r.fields} sections={sections} canEdit={canEdit}
            saving={save.isPending} onSave={(v) => save.mutate(v)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Relationship map</CardTitle></CardHeader>
        <CardContent><RelationshipMap type={type} title={r.title} relationships={r.relationships} /></CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><History className="h-4 w-4" /> Change history</CardTitle></CardHeader>
        <CardContent>
          <DataTable rows={r.history} rowKey={(h) => h.id} emptyState="No custom field changes yet."
            columns={[
              { key: "at", header: "When", render: (h) => fmtTime(h.at) },
              { key: "kind", header: "What", render: (h) => <Badge variant={h.kind === "EXTRA_SET" ? "success" : h.kind === "EXTRA_PROPOSED" ? "warning" : "default"}>{KIND_LABEL[h.kind] ?? h.kind}</Badge> },
              { key: "field_key", header: "Field", render: (h) => <span className="font-mono text-xs">{h.field_key ?? "—"}</span> },
              { key: "change", header: "Change", render: (h) => <span className="break-words">{fmtValue(h.before)} → {fmtValue(h.after)}</span> },
              { key: "actor", header: "By" },
              { key: "version", header: "Template", render: (h) => h.version ? `v${h.version}` : "—" },
            ]} />
        </CardContent>
      </Card>
    </div>
  );
}
