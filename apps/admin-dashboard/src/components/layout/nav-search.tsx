"use client";

// Global page search in the navbar. Filters the persona-curated nav list by
// label/group/path and jumps to the picked page. ⌘K / Ctrl+K focuses it.
// Presentation-only: navigates to existing pages, no flow changes.

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { navItems, personaNav, type NavPersona } from "@/lib/nav";

export function NavSearch() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const me = useQuery({
    queryKey: ["me:persona"],
    queryFn: async () => (await fetch("/api/auth/me").then((r) => r.json())) as { persona: NavPersona },
    staleTime: 5 * 60_000,
  });
  const persona: NavPersona = me.data?.persona ?? "SUPER_ADMIN";
  const items = useMemo(() => personaNav(navItems, persona), [persona]);

  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return items
      .filter((i) => i.label.toLowerCase().includes(s) || i.group.toLowerCase().includes(s) || i.href.toLowerCase().includes(s))
      .slice(0, 8);
  }, [q, items]);

  // ⌘K / Ctrl+K focuses the search from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Click outside closes the dropdown.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  useEffect(() => { setIdx(0); }, [q]);

  const go = (href: string) => {
    setOpen(false);
    setQ("");
    inputRef.current?.blur();
    router.push(href);
  };

  return (
    <div ref={boxRef} className="relative w-full max-w-md">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--color-text-muted)]" aria-hidden />
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Escape") { setOpen(false); inputRef.current?.blur(); }
          else if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(i + 1, matches.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
          else if (e.key === "Enter" && matches[idx]) { e.preventDefault(); go(matches[idx].href); }
        }}
        placeholder="Search pages…  (⌘K)"
        aria-label="Search pages"
        className="h-9 w-full rounded-xl border bg-[color:var(--color-surface-muted)] pl-8 pr-3 text-sm placeholder:text-[color:var(--color-text-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-brand)]"
      />
      {open && q.trim() && (
        <div className="absolute left-0 right-0 top-11 z-50 overflow-hidden rounded-xl border bg-[color:var(--color-surface)] shadow-xl">
          {matches.length === 0 ? (
            <p className="px-3 py-2.5 text-sm text-[color:var(--color-text-muted)]">No pages match &ldquo;{q.trim()}&rdquo;</p>
          ) : (
            <ul>
              {matches.map((m, i) => {
                const Icon = m.icon;
                return (
                  <li key={m.href}>
                    <button
                      type="button"
                      onMouseEnter={() => setIdx(i)}
                      onClick={() => go(m.href)}
                      className={cn(
                        "flex w-full items-center gap-3 px-3 py-2 text-left text-sm",
                        i === idx ? "bg-[color:var(--color-brand-muted)] text-[color:var(--color-brand)]" : "text-[color:var(--color-text)]",
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" aria-hidden />
                      <span className="flex-1 truncate font-medium">{m.label}</span>
                      <span className="text-xs text-[color:var(--color-text-muted)]">{m.group}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
