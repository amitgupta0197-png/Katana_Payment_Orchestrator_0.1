"use client";

// Global search in the navbar. ⌘K / Ctrl+K focuses it.
//  - Pages: the persona's own menu (lib/nav personaNav, flags and Access Matrix applied),
//    hubbed pages included and named by their hub ("FIFO › Reports").
//  - Entities (staff only): merchants, bankers and TSPs by code or name, from /api/nav/search.
//  - Recent: the last 5 menu pages visited in this browser, pinned at the top.
// Results are grouped by section; ↑ ↓ move, Enter opens, Esc closes.
// Presentation-only: navigates to existing pages, no flow changes.

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Building2, History, Search, Store, UserPlus, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { navTrail, type NavItem } from "@/lib/nav";
import { useNav } from "./use-nav";

const RECENT_KEY = "katana.nav.recent";
const RECENT_MAX = 5;

interface Entity { kind: "merchant" | "banker" | "tsp"; id: string; code: string; name: string; href: string }
interface Row { key: string; href: string; title: string; subtitle?: string; icon: LucideIcon; section: string }

const ENTITY_SECTION: Record<Entity["kind"], { section: string; icon: LucideIcon }> = {
  merchant: { section: "Merchants", icon: UserPlus },
  banker: { section: "Bankers", icon: Store },
  tsp: { section: "TSPs", icon: Building2 },
};

function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, RECENT_MAX) : [];
  } catch { return []; }
}

/** The menu page a pathname is on: the longest href that matches it. */
function pageFor(pathname: string, items: NavItem[]): NavItem | undefined {
  let best: NavItem | undefined;
  for (const i of items) {
    const hit = i.href === "/" ? pathname === "/" : pathname === i.href || pathname.startsWith(i.href + "/");
    if (hit && (!best || i.href.length > best.href.length)) best = i;
  }
  return best;
}

const pageRow = (i: NavItem, section: string): Row =>
  ({ key: `${section}:${i.href}`, href: i.href, title: navTrail(i), subtitle: section === "Recent" ? i.group : undefined, icon: i.icon, section });

export function NavSearch() {
  const router = useRouter();
  const pathname = usePathname();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const { persona, visible: items } = useNav();
  const staff = persona !== "PROVIDER" && persona !== "MERCHANT";

  // Remember the menu pages visited (last 5, newest first).
  useEffect(() => { setRecent(readRecent()); }, []);
  useEffect(() => {
    const page = pageFor(pathname, items);
    if (!page) return;
    setRecent((prev) => {
      const next = [page.href, ...prev.filter((h) => h !== page.href)].slice(0, RECENT_MAX);
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, [pathname, items]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);

  const entitiesQ = useQuery({
    queryKey: ["nav:search", debounced],
    enabled: staff && debounced.length >= 2,
    queryFn: async () => {
      const r = await fetch(`/api/nav/search?q=${encodeURIComponent(debounced)}`);
      if (!r.ok) return [] as Entity[];
      return ((await r.json()) as { entities?: Entity[] }).entities ?? [];
    },
    staleTime: 30_000,
  });

  const rows = useMemo<Row[]>(() => {
    const s = q.trim().toLowerCase();
    const byHref = new Map(items.map((i) => [i.href, i]));
    const matches = (i: NavItem) => !s || navTrail(i).toLowerCase().includes(s) || i.group.toLowerCase().includes(s) || i.href.toLowerCase().includes(s);
    const recentItems = recent.map((h) => byHref.get(h)).filter((i): i is NavItem => !!i && matches(i));
    const out: Row[] = recentItems.map((i) => pageRow(i, "Recent"));
    if (!s) return out;
    const taken = new Set(recentItems.map((i) => i.href));
    // Pages, grouped by their menu section in menu order.
    const pages = items.filter((i) => !taken.has(i.href) && matches(i)).slice(0, 12);
    for (const i of pages) out.push(pageRow(i, i.group));
    if (debounced.toLowerCase() === s) {
      for (const e of entitiesQ.data ?? []) {
        const meta = ENTITY_SECTION[e.kind];
        out.push({ key: `${e.kind}:${e.id}`, href: e.href, title: e.code, subtitle: e.name, icon: meta.icon, section: meta.section });
      }
    }
    return out;
  }, [q, debounced, items, recent, entitiesQ.data]);

  // Group consecutive rows by section, keeping each row's flat index for the keyboard.
  const sections = useMemo(() => {
    const order: string[] = [];
    const map = new Map<string, { row: Row; i: number }[]>();
    rows.forEach((row, i) => {
      if (!map.has(row.section)) { map.set(row.section, []); order.push(row.section); }
      map.get(row.section)!.push({ row, i });
    });
    return order.map((name) => ({ name, rows: map.get(name)! }));
  }, [rows]);

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
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${idx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  const go = (href: string) => {
    setOpen(false);
    setQ("");
    inputRef.current?.blur();
    router.push(href);
  };

  const showPanel = open && (q.trim() !== "" || rows.length > 0);
  const searching = staff && q.trim().length >= 2 && (debounced !== q.trim() || entitiesQ.isFetching);

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
          else if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setIdx((i) => Math.min(i + 1, rows.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
          else if (e.key === "Enter" && rows[idx]) { e.preventDefault(); go(rows[idx].href); }
        }}
        placeholder={staff ? "Search pages, merchants, bankers…  (⌘K)" : "Search pages…  (⌘K)"}
        aria-label="Search"
        role="combobox"
        aria-expanded={showPanel}
        aria-controls="nav-search-list"
        className="h-9 w-full rounded-xl border bg-[color:var(--color-surface-muted)] pl-8 pr-3 text-sm placeholder:text-[color:var(--color-text-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-brand)]"
      />
      {showPanel && (
        <div ref={listRef} id="nav-search-list" role="listbox" className="absolute left-0 right-0 top-11 z-50 max-h-[70vh] overflow-y-auto rounded-xl border bg-[color:var(--color-surface)] shadow-xl">
          {rows.length === 0 ? (
            <p className="px-3 py-2.5 text-sm text-[color:var(--color-text-muted)]">
              {searching ? "Searching…" : <>Nothing matches &ldquo;{q.trim()}&rdquo;</>}
            </p>
          ) : (
            sections.map((sec) => (
              <div key={sec.name} className="py-1">
                <p className="flex items-center gap-1.5 px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-widest text-[color:var(--color-text-subtle)]">
                  {sec.name === "Recent" && <History className="h-3 w-3" aria-hidden />}
                  {sec.name}
                </p>
                <ul>
                  {sec.rows.map(({ row, i }) => {
                    const Icon = row.icon;
                    return (
                      <li key={row.key} role="option" aria-selected={i === idx}>
                        <button
                          type="button"
                          data-idx={i}
                          onMouseEnter={() => setIdx(i)}
                          onClick={() => go(row.href)}
                          className={cn(
                            "flex w-full items-center gap-3 px-3 py-2 text-left text-sm",
                            i === idx ? "bg-[color:var(--color-brand-muted)] text-[color:var(--color-brand)]" : "text-[color:var(--color-text)]",
                          )}
                        >
                          <Icon className="h-4 w-4 shrink-0" aria-hidden />
                          <span className="flex-1 truncate font-medium">{row.title}</span>
                          {row.subtitle && <span className="max-w-[45%] truncate text-xs text-[color:var(--color-text-muted)]">{row.subtitle}</span>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
          {searching && rows.length > 0 && (
            <p className="border-t px-3 py-1.5 text-xs text-[color:var(--color-text-subtle)]">Searching merchants, bankers and TSPs…</p>
          )}
        </div>
      )}
    </div>
  );
}
