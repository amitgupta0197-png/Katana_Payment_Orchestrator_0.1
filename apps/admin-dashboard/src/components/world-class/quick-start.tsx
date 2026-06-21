"use client";

// Dismissible per-page quick-start card for non-technical onboarding. Remembers
// dismissal in localStorage. Presentation only.

import { useEffect, useState } from "react";
import { Sparkles, X } from "lucide-react";

export function QuickStartCard({ id, title, steps }: { id: string; title: string; steps: string[] }) {
  const key = `qs-dismissed:${id}`;
  const [mounted, setMounted] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => { setMounted(true); setDismissed(localStorage.getItem(key) === "1"); }, [key]);
  if (!mounted || dismissed) return null;
  return (
    <div className="mb-4 rounded-lg border border-[color:var(--color-brand)]/30 bg-[color:var(--color-brand-muted)]/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[color:var(--color-brand)] text-[color:var(--color-brand-fg)]">
            <Sparkles className="h-4 w-4" />
          </span>
          <div>
            <h3 className="text-sm font-semibold">{title}</h3>
            <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-sm text-[color:var(--color-text-muted)]">
              {steps.map((s, i) => <li key={i}>{s}</li>)}
            </ol>
          </div>
        </div>
        <button aria-label="Dismiss" onClick={() => { localStorage.setItem(key, "1"); setDismissed(true); }} className="rounded-md p-1 text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text)]">
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
