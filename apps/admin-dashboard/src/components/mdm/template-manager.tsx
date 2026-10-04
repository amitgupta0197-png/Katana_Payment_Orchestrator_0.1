"use client";

// Template Manager (/mdm/templates): each master type's field schema. Core fields are the table's
// columns, locked. Custom fields are added, edited or retired here and sent as a new version for
// a second person's approval (Maker-Checker `mdm.template_update`). Staff only.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Archive, ArchiveRestore, Eye, Layers, Lock, Pencil, Plus, Send, ShieldCheck, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  CUSTOM_FIELD_TYPES, KEY_RE, MASTERS, MASTER_TYPES, buildFormSchema, composeFields, customFieldProblem, customFields,
  describeChange, parseMasterType, templateProblem, type CustomFieldType, type MasterType, type MdmField,
} from "@/lib/mdm";
import type { Template, VersionRow } from "@/lib/mdm-store";
import { FieldForm } from "./field-form";
import { TYPE_ICON, fmtTime, muted, readJson, selectCls, slug } from "./shared";

const TYPE_LABEL: Record<string, string> = {
  string: "Text", number: "Number", boolean: "Yes / no", date: "Date", enum: "Choice", email: "Email", url: "URL",
  uuid: "ID", timestamp: "Date and time", list: "List",
};

function details(f: MdmField): string {
  const parts: string[] = [];
  if (f.options?.length) parts.push(f.options.join(" / "));
  if (f.regex) parts.push(`pattern ${f.regex}`);
  if (typeof f.min === "number") parts.push(`min ${f.min}`);
  if (typeof f.max === "number") parts.push(`max ${f.max}`);
  return parts.join(" · ");
}

type FieldDraft = { key: string; label: string; type: CustomFieldType; help: string; options: string; regex: string; min: string; max: string; requires_approval: boolean };
const EMPTY: FieldDraft = { key: "", label: "", type: "string", help: "", options: "", regex: "", min: "", max: "", requires_approval: false };

const fromDraft = (d: FieldDraft, old?: MdmField): MdmField => ({
  key: d.key.trim(), label: d.label.trim(), type: d.type, required: false,
  ...(d.help.trim() ? { help: d.help.trim() } : {}),
  ...(d.type === "enum" ? { options: d.options.split(/[,\n]/).map((s) => s.trim()).filter(Boolean) } : {}),
  ...(d.regex.trim() && ["string", "email", "url"].includes(d.type) ? { regex: d.regex.trim() } : {}),
  ...(d.min.trim() !== "" && d.type !== "boolean" && d.type !== "enum" && d.type !== "date" ? { min: Number(d.min) } : {}),
  ...(d.max.trim() !== "" && d.type !== "boolean" && d.type !== "enum" && d.type !== "date" ? { max: Number(d.max) } : {}),
  ...(d.requires_approval ? { requires_approval: true } : {}),
  ...(old?.retired ? { retired: true } : {}),
});

function FieldDialog({ type, field, existingKeys, isNew, onSave, onClose }: {
  type: MasterType; field: MdmField | null; existingKeys: string[]; isNew: boolean;
  onSave: (f: MdmField) => void; onClose: () => void;
}) {
  const [d, setD] = useState<FieldDraft>(() => field ? {
    key: field.key, label: field.label, type: field.type as CustomFieldType, help: field.help ?? "", options: (field.options ?? []).join(", "),
    regex: field.regex ?? "", min: field.min?.toString() ?? "", max: field.max?.toString() ?? "", requires_approval: !!field.requires_approval,
  } : EMPTY);
  const set = <K extends keyof FieldDraft>(k: K, v: FieldDraft[K]) => setD((p) => ({ ...p, [k]: v }));
  const f = fromDraft(d, field ?? undefined);
  const coreKeys = MASTERS[type] && composeFields(type, []).map((x) => x.key);
  const problem = !d.key ? null
    : coreKeys.includes(d.key) ? `${d.key} is already a core column`
    : isNew && existingKeys.includes(d.key) ? `${d.key} already exists`
    : (d.min && !Number.isFinite(Number(d.min))) || (d.max && !Number.isFinite(Number(d.max))) ? "min and max must be numbers"
    : customFieldProblem(f);
  const typeLocked = !isNew; // a field that has been in a version keeps its type

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{field ? `Edit ${field.key}` : "New custom field"}</DialogTitle>
          <DialogDescription>Custom fields are optional and stored with each record. A field cannot be removed later, only retired.</DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (!problem && d.key && d.label) onSave(f); }}>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="cf-key">Key</Label>
              <Input id="cf-key" value={d.key} disabled={!!field} placeholder="e.g. region_code"
                onChange={(e) => set("key", e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))} />
              {d.key && !KEY_RE.test(d.key) && <p className="text-xs text-[color:var(--color-danger)]">snake_case, 2–40 characters, starting with a letter</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cf-label">Label</Label>
              <Input id="cf-label" value={d.label} onChange={(e) => set("label", e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cf-type">Type</Label>
              <select id="cf-type" className={selectCls} value={d.type} disabled={typeLocked} onChange={(e) => set("type", e.target.value as CustomFieldType)}>
                {CUSTOM_FIELD_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
              </select>
              {typeLocked && <p className={`text-xs ${muted}`}>The type is fixed once a field exists; retire it and add another to change it.</p>}
            </div>
            {d.type === "enum" && (
              <div className="space-y-1.5">
                <Label htmlFor="cf-opts">Options</Label>
                <Input id="cf-opts" value={d.options} onChange={(e) => set("options", e.target.value)} placeholder="NORTH, SOUTH, EAST, WEST" />
              </div>
            )}
            {["string", "email", "url"].includes(d.type) && (
              <div className="space-y-1.5">
                <Label htmlFor="cf-re">Pattern (regular expression)</Label>
                <Input id="cf-re" value={d.regex} onChange={(e) => set("regex", e.target.value)} placeholder="optional, e.g. [A-Z]{4}[0-9]{2}" className="font-mono" />
              </div>
            )}
            {["string", "email", "url", "number"].includes(d.type) && (
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5"><Label htmlFor="cf-min">{d.type === "number" ? "Min" : "Min length"}</Label><Input id="cf-min" inputMode="decimal" value={d.min} onChange={(e) => set("min", e.target.value)} /></div>
                <div className="space-y-1.5"><Label htmlFor="cf-max">{d.type === "number" ? "Max" : "Max length"}</Label><Input id="cf-max" inputMode="decimal" value={d.max} onChange={(e) => set("max", e.target.value)} /></div>
              </div>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cf-help">Help text</Label>
            <Input id="cf-help" value={d.help} onChange={(e) => set("help", e.target.value)} placeholder="Shown under the field" />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={d.requires_approval} onChange={(e) => set("requires_approval", e.target.checked)} />
            A change to this field&apos;s value needs a second person&apos;s approval
          </label>
          {problem && <p className="text-sm text-[color:var(--color-danger)]">{problem}</p>}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!!problem || !d.key || !d.label.trim()}>{field ? "Keep changes" : "Add field"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TemplateEditor({ type }: { type: MasterType }) {
  const qc = useQueryClient();
  const router = useRouter();
  const q = useQuery({
    queryKey: ["mdm", "template", type],
    queryFn: async () => readJson<{ template: Template; versions: VersionRow[] }>(await fetch(`/api/mdm/templates/${slug(type)}`)),
  });
  const current = useMemo(() => customFields(q.data?.template.fields ?? []), [q.data]);
  const [draft, setDraft] = useState<MdmField[]>([]);
  const [editing, setEditing] = useState<{ field: MdmField | null } | null>(null);
  const [preview, setPreview] = useState(false);
  const [notes, setNotes] = useState("");
  useEffect(() => { setDraft(current); }, [current]);

  const proposed = composeFields(type, draft);
  const changes = q.data ? describeChange(q.data.template.fields, proposed) : [];
  const problem = q.data ? templateProblem(type, proposed, q.data.template.fields) : null;
  const pending = q.data?.template.pending;

  const submit = useMutation({
    mutationFn: async () => readJson<{ request_id: string; changes: string[] }>(await fetch(`/api/mdm/templates/${slug(type)}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ custom_fields: draft, notes: notes.trim() || undefined }),
    })),
    onSuccess: (r) => {
      toast.success("Sent for approval", {
        description: `${r.changes.join(", ")}. A second person approves it on Maker-Checker.`,
        action: { label: "Open Maker-Checker", onClick: () => router.push("/admin/maker-checker") },
      });
      setNotes("");
      qc.invalidateQueries({ queryKey: ["mdm"] });
    },
    onError: (e: Error) => toast.error("Could not send the change", { description: e.message }),
  });

  if (q.isLoading) return <p className={`text-sm ${muted}`}>Loading…</p>;
  if (q.error || !q.data) return <p className="text-sm text-[color:var(--color-danger)]">{(q.error as Error)?.message ?? "Not found"}</p>;
  const t = q.data.template;
  const isNewKey = (k: string) => !current.some((f) => f.key === k);

  const coreCols: Column<MdmField>[] = [
    { key: "lock", header: "", width: "2rem", render: () => <Lock className={`h-3.5 w-3.5 ${muted}`} aria-label="Locked" /> },
    { key: "key", header: "Column", render: (f) => <span className="font-mono text-xs">{f.key}</span> },
    { key: "label", header: "Label" },
    { key: "type", header: "Type", render: (f) => TYPE_LABEL[f.type] ?? f.type },
    { key: "required", header: "Required", render: (f) => f.required ? <Badge variant="info">Required</Badge> : <span className={muted}>Optional</span> },
    { key: "notes", header: "Notes", render: (f) => <span className={`text-xs ${muted}`}>{[f.sensitive ? "Hidden in MDM" : "", f.notes ?? "", f.options?.join(" / ") ?? ""].filter(Boolean).join(" · ") || "—"}</span> },
  ];
  const customCols: Column<MdmField>[] = [
    { key: "key", header: "Key", render: (f) => <span className="font-mono text-xs">{f.key}</span> },
    { key: "label", header: "Label" },
    { key: "type", header: "Type", render: (f) => TYPE_LABEL[f.type] ?? f.type },
    { key: "details", header: "Rules", render: (f) => <span className={`text-xs ${muted}`}>{details(f) || "—"}</span> },
    { key: "approval", header: "Approval", render: (f) => f.requires_approval ? <span className="inline-flex items-center gap-1 text-xs"><ShieldCheck className="h-3.5 w-3.5 text-[color:var(--color-warning)]" /> Second person</span> : <span className={`text-xs ${muted}`}>—</span> },
    { key: "state", header: "State", render: (f) => isNewKey(f.key) ? <Badge variant="info">New</Badge> : f.retired ? <Badge>Retired</Badge> : <Badge variant="success">Active</Badge> },
    { key: "actions", header: "", className: "text-right", render: (f) => (
      <div className="flex justify-end gap-1">
        {!f.retired && <Button size="sm" variant="ghost" onClick={() => setEditing({ field: f })} aria-label={`Edit ${f.key}`}><Pencil className="h-4 w-4" /></Button>}
        {isNewKey(f.key)
          ? <Button size="sm" variant="ghost" onClick={() => setDraft((d) => d.filter((x) => x.key !== f.key))} aria-label={`Remove ${f.key}`}><Trash2 className="h-4 w-4" /></Button>
          : <Button size="sm" variant="ghost" onClick={() => setDraft((d) => d.map((x) => x.key === f.key ? { ...x, retired: !x.retired || undefined } : x))}>
              {f.retired ? <><ArchiveRestore className="h-4 w-4" /> Restore</> : <><Archive className="h-4 w-4" /> Retire</>}
            </Button>}
      </div>
    ) },
  ];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">{MASTERS[type].label} template <Badge variant="brand">v{t.version}</Badge></CardTitle>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => setPreview(true)}><Eye className="h-4 w-4" /> Preview form</Button>
            <Button asChild variant="secondary" size="sm"><Link href={`/mdm/${slug(type)}`}>Open records</Link></Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {pending && (
            <div className="rounded-lg border border-[color:var(--color-warning)]/40 bg-[color:var(--color-warning-muted)] p-3 text-sm">
              <div className="font-medium">A change is awaiting approval</div>
              <div className={muted}>{pending.changes.join(", ") || "no visible change"} · by {pending.maker_email} · {fmtTime(pending.created_at)}</div>
              <Link className="text-[color:var(--color-brand)] underline-offset-4 hover:underline" href="/admin/maker-checker">Open Maker-Checker</Link>
            </div>
          )}
          <section>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold"><Lock className="h-4 w-4" /> Core fields <span className={`text-xs font-normal ${muted}`}>The table&apos;s own columns. Locked; edited on each record&apos;s own page.</span></h3>
            <DataTable columns={coreCols} rows={t.fields.filter((f) => f.core)} rowKey={(f) => f.key} />
          </section>
          <section>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Custom fields <span className={`text-xs font-normal ${muted}`}>Optional, stored with each record.</span></h3>
              <Button size="sm" onClick={() => setEditing({ field: null })}><Plus className="h-4 w-4" /> Add field</Button>
            </div>
            <DataTable columns={customCols} rows={draft} rowKey={(f) => f.key} emptyState="No custom fields. Add one to collect more about each record." />
          </section>
          <div className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-end">
            <div className="flex-1 space-y-1.5">
              <div className="text-sm">
                {changes.length ? <>Version {t.version + 1} would <b className="font-medium">{changes.join(", ")}</b>.</> : <span className={muted}>No changes yet.</span>}
              </div>
              {problem && changes.length > 0 && <p className="text-sm text-[color:var(--color-danger)]">{problem}</p>}
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Why (shown to the approver)" maxLength={500} />
            </div>
            <div className="flex gap-2">
              {changes.length > 0 && <Button variant="secondary" onClick={() => setDraft(current)}>Discard</Button>}
              <Button onClick={() => submit.mutate()} disabled={!changes.length || !!problem || !!pending || submit.isPending}>
                <Send className="h-4 w-4" /> {submit.isPending ? "Sending…" : "Submit for approval"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Version history</CardTitle></CardHeader>
        <CardContent>
          <DataTable rows={q.data.versions} rowKey={(v) => String(v.version)} columns={[
            { key: "version", header: "Version", render: (v) => <span className="font-medium">v{v.version}{v.version === t.version && <Badge variant="success" className="ml-2">Current</Badge>}</span> },
            { key: "changes", header: "Change", render: (v) => v.changes.join(", ") || "—" },
            { key: "custom", header: "Custom", className: "tabular-nums", render: (v) => `${v.custom}${v.retired ? ` (+${v.retired} retired)` : ""}` },
            { key: "created_by", header: "Made by" },
            { key: "approved_by", header: "Approved by", render: (v) => v.approved_by ?? "—" },
            { key: "created_at", header: "When", render: (v) => fmtTime(v.created_at) },
          ]} />
        </CardContent>
      </Card>

      {editing && (
        <FieldDialog type={type} field={editing.field} isNew={!editing.field || isNewKey(editing.field.key)} existingKeys={draft.map((f) => f.key)}
          onClose={() => setEditing(null)}
          onSave={(f) => {
            setDraft((d) => editing.field ? d.map((x) => x.key === editing.field!.key ? f : x) : [...d, f]);
            setEditing(null);
          }} />
      )}
      {preview && (
        <Dialog open onOpenChange={setPreview}>
          <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{MASTERS[type].label} form preview</DialogTitle>
              <DialogDescription>The record form as this draft would show it. Nothing is saved.</DialogDescription>
            </DialogHeader>
            <FieldForm preview fields={proposed} sections={buildFormSchema(proposed)} />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

export function TemplateManager() {
  const params = useSearchParams();
  const router = useRouter();
  const selected = parseMasterType(params.get("type")) ?? "BANK";
  const q = useQuery({ queryKey: ["mdm", "templates"], queryFn: async () => (await readJson<{ templates: Template[] }>(await fetch("/api/mdm/templates"))).templates });

  return (
    <div>
      <PageHeader title="Template Manager" icon={Layers} description="Each master type's fields. Core fields are locked; custom fields change through a second person's approval." />
      <Card className="mb-4">
        <CardContent className="pt-6">
          <DataTable rows={MASTER_TYPES.map((type) => ({ type, t: q.data?.find((x) => x.type === type) }))} loading={q.isLoading} rowKey={(r) => r.type}
            onRowClick={(r) => router.replace(`/mdm/templates?type=${slug(r.type)}`)}
            columns={[
              { key: "type", header: "Master", render: (r) => { const Icon = TYPE_ICON[r.type]; return <span className={`inline-flex items-center gap-2 font-medium ${r.type === selected ? "text-[color:var(--color-brand)]" : ""}`}><Icon className="h-4 w-4" /> {MASTERS[r.type].plural}</span>; } },
              { key: "version", header: "Version", render: (r) => r.t ? `v${r.t.version}` : "—" },
              { key: "fields", header: "Fields", className: "tabular-nums", render: (r) => r.t ? `${r.t.fields.filter((f) => f.core).length} core · ${customFields(r.t.fields).filter((f) => !f.retired).length} custom` : "—" },
              { key: "updated", header: "Last modified", render: (r) => fmtTime(r.t?.updated_at) },
              { key: "pending", header: "", render: (r) => r.t?.pending ? <Badge variant="warning">Awaiting approval</Badge> : null },
            ]} />
        </CardContent>
      </Card>
      <TemplateEditor key={selected} type={selected} />
    </div>
  );
}
