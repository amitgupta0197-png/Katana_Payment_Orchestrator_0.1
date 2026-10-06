"use client";

// A small ⓘ button that opens a short explanation next to a label: what a setting is for, in
// plain words. Opens on click or tap (works on phones), closes on a second click, Escape or a
// click elsewhere.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Info } from "lucide-react";

export function InfoTip({ label, children, align = "left" }: { label: string; children: ReactNode; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <span ref={ref} className="relative inline-flex align-middle">
      <button type="button" aria-label={`What is ${label}?`} aria-expanded={open} onClick={() => setOpen((o) => !o)}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[color:var(--color-text-muted)] hover:text-[color:var(--color-brand)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--color-brand)]">
        <Info className="h-3.5 w-3.5" />
      </button>
      {open && (
        <span role="note"
          className={`absolute top-6 z-50 w-72 rounded-lg border bg-[color:var(--color-surface)] p-3 text-xs font-normal leading-relaxed text-[color:var(--color-text)] shadow-lg ${align === "right" ? "right-0" : "left-0"}`}>
          {children}
        </span>
      )}
    </span>
  );
}
