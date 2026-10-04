"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Swords, Menu, X, ChevronDown, ChevronRight, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { navGroups, sidebarNav, type NavItem } from "@/lib/nav";
import { useNav } from "./use-nav";

/** A menu item is the page or a page under it: /settlement is not active on /settlement-engine. */
const isActive = (href: string, pathname: string) =>
  href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/");

/**
 * The sidebar entry that holds the current page: the longest matching href, where a hubbed
 * page counts for its hub (on /fifo-reports the FIFO hub is lit).
 */
function activeEntry(entries: NavItem[], all: NavItem[], pathname: string): string | null {
  let best: { href: string; len: number } | null = null;
  const shown = new Set(entries.map((e) => e.href));
  for (const i of all) {
    const owner = shown.has(i.href) ? i.href : i.parent && shown.has(i.parent) ? i.parent : null;
    if (!owner || !isActive(i.href, pathname)) continue;
    if (!best || i.href.length > best.len) best = { href: owner, len: i.href.length };
  }
  return best?.href ?? null;
}

const RAIL_KEY = "katana.nav.rail";

// Shared nav body — used by the desktop sidebar AND the mobile drawer so the two never
// drift. `onNavigate` lets the drawer close itself when a link is tapped. `rail` draws
// icons only (desktop collapse-to-icons mode).
function SidebarContent({ onNavigate, rail = false, onToggleRail }: { onNavigate?: () => void; rail?: boolean; onToggleRail?: () => void }) {
  const pathname = usePathname();
  const { persona, features, visible } = useNav();
  const entries = sidebarNav(visible, features);
  const current = activeEntry(entries, visible, pathname);
  const personaLabel = persona.toLowerCase().replace(/_/g, "-");

  // Collapsible groups — CLOSED by default (absent key = collapsed); a group the
  // user opens is remembered across sessions. The group holding the current page
  // is always rendered open so the active link never disappears.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  useEffect(() => {
    try { setCollapsed(JSON.parse(localStorage.getItem("katana.nav.collapsed") ?? "{}")); } catch { /* ignore */ }
  }, []);
  const toggleGroup = (group: string) => {
    setCollapsed((prev) => {
      const next = { ...prev, [group]: !(prev[group] ?? true) };
      try { localStorage.setItem("katana.nav.collapsed", JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };

  return (
    <>
      <div className={cn("flex h-16 items-center gap-3 border-b", rail ? "justify-center px-2" : "px-5")}>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[var(--color-brand)] to-[var(--color-brand-2)] text-[color:var(--color-brand-fg)] shadow-[0_6px_18px_-6px_var(--color-brand)]">
          <Swords className="h-4 w-4" />
        </span>
        {!rail && (
          <div className="flex flex-col">
            <span className="text-sm font-semibold leading-tight">Katana</span>
            <span className="text-xs text-[color:var(--color-text-muted)] leading-tight">Payment Orchestrator</span>
          </div>
        )}
      </div>
      <nav className={cn("flex-1 overflow-y-auto py-4", rail ? "px-2 space-y-2" : "px-3 space-y-4")}>
        {navGroups.map((group) => {
          const items = entries.filter((i) => i.group === group);
          if (items.length === 0) return null;
          const containsActive = items.some((i) => i.href === current);
          const isCollapsed = (collapsed[group] ?? true) && !containsActive;
          return (
            <div key={group}>
              {rail ? (
                <button
                  type="button"
                  onClick={() => toggleGroup(group)}
                  aria-expanded={!isCollapsed}
                  title={`${group} (${items.length})`}
                  aria-label={group}
                  className="mb-1 flex w-full items-center justify-center gap-1 rounded-md py-1 text-[9px] font-semibold uppercase tracking-widest text-[color:var(--color-text-subtle)] hover:text-[color:var(--color-text-muted)]"
                >
                  <span className="h-px flex-1 bg-[color:var(--color-border)]" />
                  <ChevronDown className={cn("h-3 w-3 shrink-0 transition-transform", isCollapsed && "-rotate-90")} aria-hidden />
                  <span className="h-px flex-1 bg-[color:var(--color-border)]" />
                </button>
              ) : (
              <button
                type="button"
                onClick={() => toggleGroup(group)}
                aria-expanded={!isCollapsed}
                className="group/hdr flex w-full items-center gap-1.5 rounded-md px-3 mb-1 py-1 text-[10px] font-semibold uppercase tracking-widest text-[color:var(--color-text-subtle)] hover:text-[color:var(--color-text-muted)]"
              >
                <span className="flex-1 truncate text-left">{group}</span>
                {isCollapsed && <span className="rounded-full bg-[color:var(--color-surface-muted)] px-1.5 text-[9px] tabular-nums normal-case tracking-normal">{items.length}</span>}
                <ChevronDown className={cn("h-3 w-3 shrink-0 transition-transform", isCollapsed && "-rotate-90")} aria-hidden />
              </button>
              )}
              {isCollapsed ? null : (
              <ul className="space-y-0.5">
                {items.map((item) => {
                  const Icon = item.icon;
                  const active = item.href === current;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={onNavigate}
                        aria-current={active ? "page" : undefined}
                        title={rail ? item.label : undefined}
                        aria-label={rail ? item.label : undefined}
                        className={cn(
                          "group flex items-center rounded-xl text-sm font-medium transition-all",
                          rail ? "justify-center px-0 py-2" : "gap-3 px-3 py-2",
                          active
                            ? "bg-gradient-to-r from-[var(--color-brand)] to-[var(--color-brand-2)] text-[color:var(--color-brand-fg)] shadow-[0_8px_20px_-8px_var(--color-brand)]"
                            : "text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text)] hover:bg-[color:var(--color-surface-muted)]"
                        )}
                      >
                        <Icon className="h-4 w-4 shrink-0" aria-hidden />
                        {!rail && <span className="flex-1 truncate">{item.label}</span>}
                        {!rail && item.hub && <ChevronRight className="h-3 w-3 shrink-0 opacity-60" aria-hidden />}
                        {!rail && item.status === "read-only" && <Badge variant="info" className="text-[10px] px-1.5">read</Badge>}
                        {!rail && item.status === "scaffold" && <Badge variant="warning" className="text-[10px] px-1.5">wip</Badge>}
                      </Link>
                    </li>
                  );
                })}
              </ul>
              )}
            </div>
          );
        })}
      </nav>
      <div className={cn("flex items-center gap-2 border-t py-3 text-xs text-[color:var(--color-text-subtle)]", rail ? "justify-center px-2" : "px-5")}>
        {!rail && <span className="flex-1 truncate">v0.1.0 · {personaLabel}</span>}
        {onToggleRail && (
          <button
            type="button"
            onClick={onToggleRail}
            title={rail ? "Expand menu" : "Collapse to icons"}
            aria-label={rail ? "Expand menu" : "Collapse menu to icons"}
            className="grid h-7 w-7 place-items-center rounded-lg hover:bg-[color:var(--color-surface-muted)] hover:text-[color:var(--color-text)]"
          >
            {rail ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
          </button>
        )}
      </div>
    </>
  );
}

// Desktop sidebar — fixed rail, hidden below md. Collapses to icons; the choice is
// remembered per browser.
export function Sidebar() {
  const [rail, setRail] = useState(false);
  useEffect(() => {
    try { setRail(localStorage.getItem(RAIL_KEY) === "1"); } catch { /* ignore */ }
  }, []);
  const toggle = () => setRail((r) => {
    try { localStorage.setItem(RAIL_KEY, r ? "0" : "1"); } catch { /* ignore */ }
    return !r;
  });
  return (
    <aside aria-label="Primary" className={cn("hidden md:flex md:flex-col md:border-r md:bg-[color:var(--color-surface)] transition-[width] duration-200", rail ? "md:w-16" : "md:w-64")}>
      <SidebarContent rail={rail} onToggleRail={toggle} />
    </aside>
  );
}

// Mobile navigation — a hamburger button (shown below md) that opens the same nav as a
// slide-in drawer. Self-contained: manages its own open state, closes on backdrop tap,
// Escape, and route change.
export function MobileNav() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close on route change.
  useEffect(() => { setOpen(false); }, [pathname]);
  // Close on Escape + lock scroll while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open menu"
        className="md:hidden -ml-1 grid h-9 w-9 place-items-center rounded-lg text-[color:var(--color-text-muted)] hover:bg-[color:var(--color-surface-muted)] hover:text-[color:var(--color-text)]"
      >
        <Menu className="h-5 w-5" />
      </button>

      {open && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <aside
            aria-label="Primary"
            className="absolute inset-y-0 left-0 flex w-[80vw] max-w-xs flex-col border-r bg-[color:var(--color-surface)] shadow-2xl animate-in slide-in-from-left duration-200"
          >
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close menu"
              className="absolute right-3 top-4 grid h-8 w-8 place-items-center rounded-lg text-[color:var(--color-text-muted)] hover:bg-[color:var(--color-surface-muted)]"
            >
              <X className="h-5 w-5" />
            </button>
            <SidebarContent onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}
    </>
  );
}
