"use client";

// Mobile navigation for the three portal shells (merchant / banker / DT banker).
//
// Each portal renders its sidebar as `hidden md:flex`, which on a phone meant no navigation
// at all — the only reachable screen was whichever one you landed on. The admin dashboard
// already solved this in components/layout/sidebar.tsx (MobileNav); this is the same
// pattern factored out so all three portals share one implementation instead of three.
//
// Self-contained: owns its open state and closes on backdrop tap, Escape, and route change.

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X, Swords } from "lucide-react";
import { cn } from "@/lib/utils";

export interface PortalNavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  exact: boolean;
}

export function PortalMobileNav({ nav, subtitle }: { nav: PortalNavItem[]; subtitle: string }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close on route change — otherwise the drawer stays over the page you just opened.
  useEffect(() => { setOpen(false); }, [pathname]);

  // Escape to close, and lock body scroll so the page behind cannot scroll under the drawer.
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
        aria-expanded={open}
        className="md:hidden -ml-1 grid h-10 w-10 shrink-0 place-items-center rounded-lg text-[color:var(--color-text-muted)] hover:bg-[color:var(--color-surface-muted)] hover:text-[color:var(--color-text)]"
      >
        <Menu className="h-5 w-5" />
      </button>

      {open && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <aside
            aria-label="Primary"
            className="absolute inset-y-0 left-0 flex w-[80vw] max-w-xs flex-col border-r bg-[color:var(--color-surface)] shadow-2xl"
          >
            <div className="flex h-16 items-center gap-3 border-b px-5">
              <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[color:var(--color-brand)] text-[color:var(--color-brand-fg)]">
                <Swords className="h-4 w-4" />
              </span>
              <div className="flex flex-col">
                <span className="text-sm font-semibold leading-tight">Katana</span>
                <span className="text-xs leading-tight text-[color:var(--color-text-muted)]">{subtitle}</span>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close menu"
                className="ml-auto grid h-9 w-9 place-items-center rounded-lg text-[color:var(--color-text-muted)] hover:bg-[color:var(--color-surface-muted)]"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-4">
              {nav.map((item) => {
                const Icon = item.icon;
                const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setOpen(false)}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      // py-2.5 rather than py-2: this is a touch target, not a cursor target.
                      "group flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors",
                      active
                        ? "bg-[color:var(--color-brand-muted)] text-[color:var(--color-brand)]"
                        : "text-[color:var(--color-text-muted)] hover:bg-[color:var(--color-surface-muted)] hover:text-[color:var(--color-text)]",
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" aria-hidden />
                    <span className="flex-1 truncate">{item.label}</span>
                  </Link>
                );
              })}
            </nav>
          </aside>
        </div>
      )}
    </>
  );
}
