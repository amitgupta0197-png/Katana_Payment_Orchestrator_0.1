"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Swords, LayoutDashboard, Receipt, Droplets, LogOut } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/layout/theme-toggle";

const NAV = [
  { href: "/banker-portal",           label: "Dashboard", icon: LayoutDashboard, exact: true  },
  { href: "/banker-portal/purchases", label: "Purchases", icon: Receipt,         exact: false },
  { href: "/banker-portal/refills",   label: "Refills",   icon: Droplets,        exact: false },
];

export function BankerPortalShell({
  children, scopeLabel, email, fullName,
}: { children: React.ReactNode; scopeLabel: string; email: string; fullName: string }) {
  const pathname = usePathname();
  const router = useRouter();

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  };

  return (
    <div className="flex min-h-screen">
      <aside
        aria-label="Banker navigation"
        className="hidden md:flex md:w-60 md:flex-col md:border-r md:bg-[color:var(--color-surface)]"
      >
        <div className="flex h-16 items-center gap-3 px-5 border-b">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[color:var(--color-brand)] text-[color:var(--color-brand-fg)]">
            <Swords className="h-4 w-4" />
          </span>
          <div className="flex flex-col">
            <span className="text-sm font-semibold leading-tight">Katana</span>
            <span className="text-xs text-[color:var(--color-text-muted)] leading-tight">
              Banker portal
            </span>
          </div>
        </div>
        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-0.5">
          {NAV.map((item) => {
            const Icon = item.icon;
            const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
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
              </Link>
            );
          })}
        </nav>
        <div className="border-t px-5 py-3 text-xs text-[color:var(--color-text-subtle)]">
          v0.1.0 · banker
        </div>
      </aside>

      <div className="flex flex-1 flex-col min-w-0">
        <header
          role="banner"
          className="flex h-16 items-center justify-between gap-4 border-b bg-[color:var(--color-surface)] px-6"
        >
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-sm font-semibold truncate">{scopeLabel}</span>
            <Badge variant="brand" className="uppercase tracking-wide">Banker</Badge>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden sm:flex flex-col items-end leading-tight text-xs">
              <span className="font-medium text-[color:var(--color-text)]">{fullName}</span>
              <span className="text-[color:var(--color-text-muted)]">{email}</span>
            </div>
            <ThemeToggle />
            <Button variant="secondary" size="sm" onClick={logout}>
              <LogOut className="h-4 w-4" /> Logout
            </Button>
          </div>
        </header>
        <main
          role="main"
          className="flex-1 overflow-y-auto px-6 py-8 bg-[color:var(--color-surface-muted)]"
        >
          <div className="mx-auto max-w-7xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
