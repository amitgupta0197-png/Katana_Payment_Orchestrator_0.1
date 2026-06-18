"use client";

// Cmd/Ctrl-K command palette. Type to search across providers/merchants/
// tenants; arrow keys to navigate; enter to open. Also exposes quick-add
// actions ("New provider", "New merchant") and quick-nav by nav label.

import * as React from "react";
import { useRouter } from "next/navigation";
import { Search, ArrowRight, Plus, ExternalLink } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { navItems } from "@/lib/nav";

interface Hit { kind: string; id: string; title: string; subtitle: string; href: string }

const QUICK_ADD = [
  { id: "qa:provider", title: "New provider", hint: "Go to providers and open Create", href: "/providers?new=1" },
  { id: "qa:merchant", title: "New merchant", hint: "Go to merchants and open Onboard", href: "/merchants?new=1" },
  { id: "qa:tenant",   title: "New tenant",   hint: "Go to tenants and open Create",   href: "/tenants?new=1" },
  { id: "qa:user",     title: "Add user",     hint: "Go to /admin/access and open Add user", href: "/admin/access?new=1" },
];

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  const [active, setActive] = React.useState(0);
  const [serverHits, setServerHits] = React.useState<Hit[]>([]);
  const [loading, setLoading] = React.useState(false);

  // Open on Cmd/Ctrl-K
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Debounced server search
  React.useEffect(() => {
    if (!open) return;
    if (q.trim().length < 2) { setServerHits([]); return; }
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(q.trim())}`);
        const data = await r.json();
        setServerHits(data.hits ?? []);
      } finally { setLoading(false); }
    }, 200);
    return () => clearTimeout(t);
  }, [q, open]);

  // Local matches: nav items + quick-add filtered by `q`
  const ql = q.trim().toLowerCase();
  const navHits = ql
    ? navItems.filter((n) => n.label.toLowerCase().includes(ql) || n.href.toLowerCase().includes(ql)).slice(0, 6)
    : navItems.slice(0, 5);
  const quickHits = ql
    ? QUICK_ADD.filter((a) => a.title.toLowerCase().includes(ql) || a.hint.toLowerCase().includes(ql))
    : QUICK_ADD;

  type Item = { id: string; group: "Quick add" | "Records" | "Pages"; title: string; subtitle: string; href: string; icon?: React.ReactNode };
  const items: Item[] = [
    ...quickHits.map((a) => ({ id: a.id, group: "Quick add" as const, title: a.title, subtitle: a.hint, href: a.href, icon: <Plus className="h-3.5 w-3.5" /> })),
    ...serverHits.map((h) => ({ id: `s:${h.kind}:${h.id}`, group: "Records" as const, title: h.title, subtitle: `${h.kind} · ${h.subtitle}`, href: h.href, icon: <ExternalLink className="h-3.5 w-3.5" /> })),
    ...navHits.map((n) => ({ id: `n:${n.href}`, group: "Pages" as const, title: n.label, subtitle: n.href, href: n.href, icon: <ArrowRight className="h-3.5 w-3.5" /> })),
  ];

  React.useEffect(() => { setActive(0); }, [q, serverHits.length]);

  const go = (item: Item) => {
    setOpen(false);
    setQ("");
    router.push(item.href);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    if (e.key === "Enter") {
      const it = items[active];
      if (it) { e.preventDefault(); go(it); }
    }
    if (e.key === "Escape") setOpen(false);
  };

  // Group items for rendering
  const groups: Record<string, Item[]> = {};
  items.forEach((it) => { (groups[it.group] = groups[it.group] ?? []).push(it); });

  let runningIndex = -1;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="!max-w-xl p-0 sm:p-0 gap-0 overflow-hidden">
        <div className="flex items-center gap-2 border-b border-[color:var(--color-border)] px-3 py-2">
          <Search className="h-4 w-4 text-[color:var(--color-text-muted)]" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Search records, pages, or actions…"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-[color:var(--color-text-muted)]"
          />
          <kbd className="ml-2 rounded border border-[color:var(--color-border)] px-1.5 py-0.5 text-[10px] text-[color:var(--color-text-muted)]">esc</kbd>
        </div>
        <div className="max-h-[60vh] overflow-y-auto py-1">
          {loading && <div className="px-3 py-2 text-xs text-[color:var(--color-text-muted)]">searching…</div>}
          {items.length === 0 && !loading && (
            <div className="px-3 py-6 text-center text-sm text-[color:var(--color-text-muted)]">
              {q ? "Nothing matched." : "Start typing to search."}
            </div>
          )}
          {Object.entries(groups).map(([group, list]) => (
            <div key={group} className="py-1">
              <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">
                {group}
              </div>
              {list.map((it) => {
                runningIndex += 1;
                const isActive = runningIndex === active;
                const idx = runningIndex;
                return (
                  <button
                    key={it.id}
                    onClick={() => go(it)}
                    onMouseEnter={() => setActive(idx)}
                    className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm ${isActive ? "bg-[color:var(--color-surface-muted)]" : ""}`}
                  >
                    {it.icon}
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{it.title}</div>
                      <div className="truncate text-xs text-[color:var(--color-text-muted)]">{it.subtitle}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-3 border-t border-[color:var(--color-border)] px-3 py-1.5 text-[10px] text-[color:var(--color-text-muted)]">
          <span>↑↓ navigate</span><span>⏎ open</span><span>esc close</span>
          <span className="ml-auto">⌘K / Ctrl-K to toggle</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
