"use client";

// Click-to-edit field. Stripe/Linear pattern — read-only by default,
// click reveals input, blur/enter saves, esc cancels. Optimistic write.

import * as React from "react";
import { Check, X, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface InlineEditProps {
  value: string;
  onSave: (next: string) => Promise<void> | void;
  placeholder?: string;
  readOnly?: boolean;
  className?: string;
  inputClassName?: string;
  multiline?: boolean;
  label?: string;
}

export function InlineEdit({
  value, onSave, placeholder = "—", readOnly, className, inputClassName, multiline, label,
}: InlineEditProps) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(value);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => { setDraft(value); }, [value]);

  const commit = async () => {
    if (draft === value) { setEditing(false); return; }
    setBusy(true);
    try { await onSave(draft); setEditing(false); }
    finally { setBusy(false); }
  };

  if (readOnly) {
    return (
      <span className={cn("text-sm", !value && "text-[color:var(--color-text-muted)]", className)}>
        {value || placeholder}
      </span>
    );
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className={cn(
          "group inline-flex items-center gap-2 rounded-md px-1 py-0.5 text-left text-sm hover:bg-[color:var(--color-surface-muted)]",
          !value && "text-[color:var(--color-text-muted)]",
          className,
        )}
        aria-label={label ? `Edit ${label}` : "Edit"}
      >
        <span>{value || placeholder}</span>
        <Pencil className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-60" />
      </button>
    );
  }

  return (
    <span className="inline-flex items-center gap-1">
      {multiline ? (
        <textarea
          autoFocus
          rows={3}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") { setDraft(value); setEditing(false); }
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit();
          }}
          className={cn(
            "min-w-[12rem] rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-2 py-1 text-sm",
            inputClassName,
          )}
        />
      ) : (
        <Input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") { setDraft(value); setEditing(false); }
            if (e.key === "Enter") commit();
          }}
          className={cn("h-8 min-w-[10rem]", inputClassName)}
        />
      )}
      <Button size="sm" className="h-7 w-7 p-0" onClick={commit} disabled={busy} aria-label="Save">
        <Check className="h-3.5 w-3.5" />
      </Button>
      <Button size="sm" variant="secondary" className="h-7 w-7 p-0" onClick={() => { setDraft(value); setEditing(false); }} aria-label="Cancel">
        <X className="h-3.5 w-3.5" />
      </Button>
    </span>
  );
}
