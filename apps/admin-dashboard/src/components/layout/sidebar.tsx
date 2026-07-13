"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Swords, Menu, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { navGroups, navItems, personaNav, type NavPersona } from "@/lib/nav";

// Shared nav body — used by the desktop sidebar AND the mobile drawer so the two never
// drift. `onNavigate` lets the drawer close itself when a link is tapped.
function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  // Read the real session persona from /api/auth/me. Render the full superset while the
  // query is in flight so the menu never flashes empty, then curate per persona.
  const me = useQuery({
    queryKey: ["me:persona"],
    queryFn: async () => (await fetch("/api/auth/me").then((r) => r.json())) as { persona: NavPersona },
    staleTime: 5 * 60_000,
  });
  const persona: NavPersona = me.data?.persona ?? "SUPER_ADMIN";
  const visibleItems = personaNav(navItems, persona);
  const personaLabel = persona.toLowerCase().replace(/_/g, "-");

  return (
    <>
      <div className="flex h-16 items-center gap-3 px-5 border-b">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-[var(--color-brand)] to-[var(--color-brand-2)] text-[color:var(--color-brand-fg)] shadow-[0_6px_18px_-6px_var(--color-brand)]">
          <Swords className="h-4 w-4" />
        </span>
        <div className="flex flex-col">
          <span className="text-sm font-semibold leading-tight">Katana</span>
          <span className="text-xs text-[color:var(--color-text-muted)] leading-tight">Payment Orchestrator</span>
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-6">
        {navGroups.map((group) => {
          const items = visibleItems.filter((i) => i.group === group);
          if (items.length === 0) return null;
          return (
            <div key={group}>
              <h4 className="px-3 mb-2 text-[10px] font-semibold uppercase tracking-widest text-[color:var(--color-text-subtle)]">{group}</h4>
              <ul className="space-y-0.5">
                {items.map((item) => {
                  const Icon = item.icon;
                  const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={onNavigate}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "group flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-all",
                          active
                            ? "bg-gradient-to-r from-[var(--color-brand)] to-[var(--color-brand-2)] text-[color:var(--color-brand-fg)] shadow-[0_8px_20px_-8px_var(--color-brand)]"
                            : "text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text)] hover:bg-[color:var(--color-surface-muted)]"
                        )}
                      >
                        <Icon className="h-4 w-4 shrink-0" aria-hidden />
                        <span className="flex-1 truncate">{item.label}</span>
                        {item.status === "read-only" && <Badge variant="info" className="text-[10px] px-1.5">read</Badge>}
                        {item.status === "scaffold" && <Badge variant="warning" className="text-[10px] px-1.5">wip</Badge>}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>
      <div className="border-t px-5 py-3 text-xs text-[color:var(--color-text-subtle)]">v0.1.0 · {personaLabel}</div>
    </>
  );
}

// Desktop sidebar — fixed rail, hidden below md.
export function Sidebar() {
  return (
    <aside aria-label="Primary" className="hidden md:flex md:w-64 md:flex-col md:border-r md:bg-[color:var(--color-surface)]">
      <SidebarContent />
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
