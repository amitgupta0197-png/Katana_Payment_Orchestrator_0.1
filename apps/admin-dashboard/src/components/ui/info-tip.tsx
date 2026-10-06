"use client";

// A small ⓘ button that opens a short explanation next to a label: what a setting is for, in
// plain words. Opens on click or tap (works on phones), closes on a second click, Escape, a
// click elsewhere or a scroll. The note is drawn in a portal with fixed position, so a card or a
// table with overflow hidden never clips it.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";

const WIDTH = 288;   // px, the note's width
const GAP = 6;

export function InfoTip({ label, children }: { label: string; children: ReactNode; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const note = useRef<HTMLSpanElement>(null);

  // Below the button, kept inside the window; above it when there is no room below.
  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const h = note.current?.offsetHeight ?? 120;
    const left = Math.min(Math.max(8, r.left), window.innerWidth - WIDTH - 8);
    const below = r.bottom + GAP;
    const top = below + h > window.innerHeight - 8 ? Math.max(8, r.top - GAP - h) : below;
    setPos({ top, left });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (!btn.current?.contains(t) && !note.current?.contains(t)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); btn.current?.focus(); } };
    const close = () => setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("touchstart", away);
    document.addEventListener("keydown", esc);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("touchstart", away);
      document.removeEventListener("keydown", esc);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  return (
    <>
      <button ref={btn} type="button" aria-label={`What is ${label}?`} aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); setOpen((o) => !o); }}
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full align-middle text-[color:var(--color-text-muted)] hover:text-[color:var(--color-brand)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--color-brand)]">
        <Info className="h-3.5 w-3.5" />
      </button>
      {open && typeof document !== "undefined" && createPortal(
        <span ref={note} role="note"
          style={{ position: "fixed", top: pos?.top ?? -9999, left: pos?.left ?? -9999, width: WIDTH }}
          className="z-[100] block rounded-lg border bg-[color:var(--color-surface)] p-3 text-left text-xs font-normal normal-case leading-relaxed tracking-normal text-[color:var(--color-text)] shadow-lg">
          {children}
        </span>,
        document.body,
      )}
    </>
  );
}
