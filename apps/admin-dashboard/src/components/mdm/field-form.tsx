"use client";

// Renders a record form from a template (lib/mdm buildFormSchema): core fields read-only with a
// lock, custom fields editable, retired ones read-only. Used by the Template Manager's preview
// (no values, nothing saved) and by the record view (values, saves the custom fields).

import { useMemo, useState } from "react";
import { Lock, ShieldCheck } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { valueProblem, type FormField, type FormSection, type MdmField } from "@/lib/mdm";
import { fmtValue, muted, selectCls } from "./shared";

type Values = Record<string, unknown>;

/** The form's text state back into typed values; blank means "clear". */
function toValue(f: FormField, raw: unknown): unknown {
  if (f.input === "checkbox") return raw === "" || raw === undefined ? null : raw === true || raw === "true";
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  if (f.input === "number") { const n = Number(raw); return Number.isFinite(n) ? n : String(raw); }
  return String(raw).trim();
}
const toText = (v: unknown) => (v === undefined || v === null ? "" : String(v));

function ReadOnly({ f }: { f: FormField }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <Lock className={`h-3 w-3 ${muted}`} aria-hidden /> {f.label}
        {f.required && <span className={muted}>· required</span>}
      </div>
      <div className="min-h-9 rounded-md border border-dashed px-3 py-2 text-sm break-words bg-[color:var(--color-surface-muted)]">
        {fmtValue(f.value, { sensitive: f.sensitive, type: f.input === "datetime" ? "timestamp" : undefined })}
      </div>
      {f.help && <p className={`text-xs ${muted}`}>{f.help}</p>}
    </div>
  );
}

export function FieldForm({
  sections, fields, onSave, saving, preview, canEdit = true,
}: {
  sections: FormSection[];
  /** The template's fields, to check values in the browser before sending. */
  fields: MdmField[];
  onSave?: (values: Values) => void;
  saving?: boolean;
  /** Preview: inputs work, nothing is saved, core fields show placeholders. */
  preview?: boolean;
  canEdit?: boolean;
}) {
  const custom = sections.find((s) => s.id === "custom")?.fields ?? [];
  const initial = useMemo(() => Object.fromEntries(custom.map((f) => [f.key, f.input === "checkbox" ? (f.value === undefined ? "" : f.value) : toText(f.value)])), [custom]);
  const [draft, setDraft] = useState<Values>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const changed = custom.filter((f) => JSON.stringify(toValue(f, draft[f.key])) !== JSON.stringify(f.value ?? null));

  const submit = () => {
    const errs: Record<string, string> = {};
    const out: Values = {};
    for (const f of changed) {
      const v = toValue(f, draft[f.key]);
      const def = fields.find((x) => x.key === f.key);
      if (v !== null && def) { const p = valueProblem(def, v); if (p) { errs[f.key] = p; continue; } }
      out[f.key] = v;
    }
    setErrors(errs);
    if (!Object.keys(errs).length && onSave) onSave(out);
  };

  return (
    <div className="space-y-6">
      {sections.map((s) => (
        <section key={s.id}>
          <div className="mb-3 flex items-center gap-2">
            <h3 className="text-sm font-semibold">{s.title}</h3>
            {s.readOnly && <Badge variant="default"><Lock className="mr-1 h-3 w-3" /> Read-only</Badge>}
            <span className={`text-xs ${muted}`}>{s.fields.length} field{s.fields.length === 1 ? "" : "s"}</span>
          </div>
          {!s.fields.length ? (
            <p className={`text-sm ${muted}`}>{s.id === "custom" ? "No custom fields yet. Add them in the Template Manager." : "None."}</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {s.fields.map((f) => s.readOnly || !canEdit ? <ReadOnly key={f.key} f={preview && s.id === "core" ? { ...f, value: undefined } : f} /> : (
                <div key={f.key} className="space-y-1">
                  <Label htmlFor={`mdm-${f.key}`} className="flex items-center gap-1.5">
                    {f.label}
                    {f.requiresApproval && <span title="A change needs a second person's approval"><ShieldCheck className="h-3.5 w-3.5 text-[color:var(--color-warning)]" aria-label="Needs approval" /></span>}
                  </Label>
                  {f.input === "checkbox" ? (
                    <select id={`mdm-${f.key}`} className={selectCls} value={toText(draft[f.key])}
                      onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value === "" ? "" : e.target.value === "true" }))}>
                      <option value="">Not set</option><option value="true">Yes</option><option value="false">No</option>
                    </select>
                  ) : f.input === "select" ? (
                    <select id={`mdm-${f.key}`} className={selectCls} value={toText(draft[f.key])} onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}>
                      <option value="">Not set</option>
                      {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : (
                    <Input id={`mdm-${f.key}`} type={f.input === "number" ? "number" : f.input === "date" ? "date" : f.input === "email" ? "email" : f.input === "url" ? "url" : "text"}
                      value={toText(draft[f.key])} onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                      min={f.input === "number" ? f.min : undefined} max={f.input === "number" ? f.max : undefined} />
                  )}
                  {errors[f.key] ? <p className="text-xs text-[color:var(--color-danger)]">{f.label} {errors[f.key]}</p>
                    : f.help && <p className={`text-xs ${muted}`}>{f.help}</p>}
                </div>
              ))}
            </div>
          )}
        </section>
      ))}
      {canEdit && custom.length > 0 && (
        <div className="flex items-center justify-end gap-3">
          {preview ? <span className={`text-xs ${muted}`}>Preview only: nothing is saved.</span>
            : <span className={`text-xs ${muted}`}>{changed.length ? `${changed.length} change${changed.length === 1 ? "" : "s"}` : "No changes"}</span>}
          {!preview && <Button onClick={submit} disabled={saving || !changed.length}>{saving ? "Saving…" : "Save custom fields"}</Button>}
        </div>
      )}
    </div>
  );
}
