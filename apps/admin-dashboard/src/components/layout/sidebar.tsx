"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Swords } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { navGroups, navItems } from "@/lib/nav";

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside
      aria-label="Primary"
      className="hidden md:flex md:w-64 md:flex-col md:border-r md:bg-[color:var(--color-surface)]"
    >
      <div className="flex h-16 items-center gap-3 px-5 border-b">
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[color:var(--color-brand)] text-[color:var(--color-brand-fg)]">
          <Swords className="h-4 w-4" />
        </span>
        <div className="flex flex-col">
          <span className="text-sm font-semibold leading-tight">Katana</span>
          <span className="text-xs text-[color:var(--color-text-muted)] leading-tight">
            Payment Orchestrator
          </span>
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-6">
        {navGroups.map((group) => {
          const items = navItems.filter((i) => i.group === group);
          return (
            <div key={group}>
              <h4 className="px-3 mb-2 text-[10px] font-semibold uppercase tracking-widest text-[color:var(--color-text-subtle)]">
                {group}
              </h4>
              <ul className="space-y-0.5">
                {items.map((item) => {
                  const Icon = item.icon;
                  const active =
                    item.href === "/"
                      ? pathname === "/"
                      : pathname.startsWith(item.href);
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "group flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                          active
                            ? "bg-[color:var(--color-brand-muted)] text-[color:var(--color-brand)]"
                            : "text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text)] hover:bg-[color:var(--color-surface-muted)]"
                        )}
                      >
                        <Icon className="h-4 w-4 shrink-0" aria-hidden />
                        <span className="flex-1 truncate">{item.label}</span>
                        {item.status === "read-only" && (
                          <Badge variant="info" className="text-[10px] px-1.5">
                            read
                          </Badge>
                        )}
                        {item.status === "scaffold" && (
                          <Badge variant="warning" className="text-[10px] px-1.5">
                            wip
                          </Badge>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>
      <div className="border-t px-5 py-3 text-xs text-[color:var(--color-text-subtle)]">
        v0.1.0 · super-admin
      </div>
    </aside>
  );
}
