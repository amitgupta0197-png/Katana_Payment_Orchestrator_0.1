"use client";

// The frame of the merchant portal and the banker portal: one shell for both, configured by each
// portal's own portal-shell.tsx.
//
//   menu        a few groups (Payments, Money, Help…) instead of a long list; the group holding
//               the open page is expanded. Developer pages sit behind a "Developer tools" switch,
//               remembered per browser, and always show while one of them is open.
//   search      the header box finds a payment by txnid, UTR, amount or phone (/find)
//   phone       a tab bar at the bottom (Home, Payments, Search, Help, Menu) and a drawer with the
//               full menu; the sidebar is for wider screens
//
// usePortal() tells pages which portal they are in and whether the assistant is open.

import { createContext, useContext, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ChevronDown, Code2, Home, LogOut, Menu, Search, Sparkles, HelpCircle, Swords, X, Receipt } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { ModeSwitch } from "@/components/layout/mode-switch";
import { TestModeBanner } from "@/components/layout/test-mode-banner";

export type Icon = React.ComponentType<{ className?: string }>;
export interface NavLink { href: string; label: string; icon: Icon }
export interface NavGroup { id: string; label: string; icon: Icon; items: NavLink[] }

export interface PortalInfo { base: "/merchant-portal" | "/banker-portal"; assistant: boolean }
const PortalContext = createContext<PortalInfo | null>(null);
/** The portal a page is in, or null on a staff page. */
export const usePortal = () => useContext(PortalContext);

const store = {
  get(k: string) { try { return window.localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { window.localStorage.setItem(k, v); } catch { /* private mode */ } },
};

function isActive(pathname: string, href: string, base: string) {
  return href === base ? pathname === base : pathname === href || pathname.startsWith(`${href}/`);
}

function NavTree({ base, groups, devGroup, pathname, onNavigate }: {
  base: string; groups: NavGroup[]; devGroup: NavGroup | null; pathname: string; onNavigate?: () => void;
}) {
  const activeGroup = [...groups, ...(devGroup ? [devGroup] : [])].find((g) => g.items.some((i) => isActive(pathname, i.href, base)))?.id ?? null;
  const [open, setOpen] = useState<Set<string>>(() => new Set(activeGroup ? [activeGroup] : []));
  const [dev, setDev] = useState(false);
  useEffect(() => { setDev(store.get(`${base}:dev`) === "1"); }, [base]);
  useEffect(() => { if (activeGroup) setOpen((s) => (s.has(activeGroup) ? s : new Set(s).add(activeGroup))); }, [activeGroup]);
  const showDev = dev || activeGroup === devGroup?.id;
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const link = (i: NavLink, nested: boolean) => {
    const Icon = i.icon, active = isActive(pathname, i.href, base);
    return (
      <Link key={i.href} href={i.href} onClick={onNavigate} aria-current={active ? "page" : undefined}
        className={cn("flex min-h-10 items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
          nested && "pl-9",
          active ? "bg-[color:var(--color-brand-muted)] text-[color:var(--color-brand)]"
            : "text-[color:var(--color-text-muted)] hover:bg-[color:var(--color-surface-muted)] hover:text-[color:var(--color-text)]")}>
        {!nested && <Icon className="h-4 w-4 shrink-0" />}
        <span className="truncate">{i.label}</span>
      </Link>
    );
  };
  const group = (g: NavGroup) => {
    const Icon = g.icon, isOpen = open.has(g.id), hasActive = g.id === activeGroup;
    return (
      <div key={g.id}>
        <button type="button" onClick={() => toggle(g.id)} aria-expanded={isOpen}
          className={cn("flex min-h-10 w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors hover:bg-[color:var(--color-surface-muted)]",
            hasActive ? "text-[color:var(--color-text)]" : "text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text)]")}>
          <Icon className="h-4 w-4 shrink-0" />
          <span className="flex-1 text-left">{g.label}</span>
          <ChevronDown className={cn("h-4 w-4 transition-transform", isOpen && "rotate-180")} />
        </button>
        {isOpen && <div className="mt-0.5 space-y-0.5">{g.items.map((i) => link(i, true))}</div>}
      </div>
    );
  };

  return (
    <nav className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 space-y-0.5 overflow-y-auto px-3 py-4">
        {link({ href: base, label: "Home", icon: Home }, false)}
        {groups.map(group)}
        {devGroup && showDev && group(devGroup)}
      </div>
      {devGroup && (
        <label className="flex cursor-pointer items-center justify-between gap-2 border-t px-5 py-3 text-xs text-[color:var(--color-text-muted)]">
          <span className="inline-flex items-center gap-2"><Code2 className="h-3.5 w-3.5" /> Developer tools</span>
          <input type="checkbox" className="h-4 w-4 accent-[color:var(--color-brand)]" checked={showDev}
            onChange={(e) => { setDev(e.target.checked); store.set(`${base}:dev`, e.target.checked ? "1" : "0"); }} />
        </label>
      )}
    </nav>
  );
}

function Brand({ subtitle, bare }: { subtitle: string; bare?: boolean }) {
  return (
    <div className={cn("flex h-16 items-center gap-3 px-5", !bare && "border-b")}>
      <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[color:var(--color-brand)] text-[color:var(--color-brand-fg)]">
        <Swords className="h-4 w-4" />
      </span>
      <div className="flex flex-col">
        <span className="text-sm font-semibold leading-tight">Katana</span>
        <span className="text-xs leading-tight text-[color:var(--color-text-muted)]">{subtitle}</span>
      </div>
    </div>
  );
}

/** The header's search: a payment by txnid, UTR, amount or the customer's phone. */
export function PortalSearchBox({ base, className, autoFocus, initial = "" }: { base: string; className?: string; autoFocus?: boolean; initial?: string }) {
  const router = useRouter();
  const [q, setQ] = useState(initial);
  useEffect(() => { setQ(initial); }, [initial]);
  return (
    <form role="search" className={cn("relative", className)}
      onSubmit={(e) => { e.preventDefault(); if (q.trim()) router.push(`${base}/find?q=${encodeURIComponent(q.trim())}`); }}>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--color-text-subtle)]" />
      <input value={q} onChange={(e) => setQ(e.target.value)} autoFocus={autoFocus} inputMode="search" enterKeyHint="search"
        aria-label="Find a payment" placeholder="Find a payment: order no., UTR, amount or phone"
        className="h-10 w-full rounded-xl border bg-[color:var(--color-surface-muted)] pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-[color:var(--color-text-subtle)] focus:border-[color:var(--color-brand)] focus:bg-[color:var(--color-surface)]" />
    </form>
  );
}

export function PortalFrame({ base, subtitle, badge, groups, devGroup, paymentsHref, assistant, scopeLabel, email, fullName, livemode, children }: {
  base: PortalInfo["base"]; subtitle: string; badge: string;
  groups: NavGroup[]; devGroup: NavGroup | null; paymentsHref: string; assistant: boolean;
  scopeLabel: string; email: string; fullName: string; livemode: boolean; children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [drawer, setDrawer] = useState(false);
  useEffect(() => { setDrawer(false); }, [pathname]);
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setDrawer(false); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow; document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [drawer]);

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  };

  const help = assistant ? { href: `${base}/assistant`, label: "Assistant", icon: Sparkles } : { href: `${base}/help`, label: "Help", icon: HelpCircle };
  const tabs: { href: string | null; label: string; icon: Icon; active: boolean; onClick?: () => void }[] = [
    { href: base, label: "Home", icon: Home, active: pathname === base },
    { href: paymentsHref, label: "Payments", icon: Receipt, active: pathname.startsWith(paymentsHref) },
    { href: `${base}/find`, label: "Search", icon: Search, active: pathname.startsWith(`${base}/find`) },
    { href: help.href, label: help.label, icon: help.icon, active: pathname.startsWith(help.href) },
    { href: null, label: "Menu", icon: Menu, active: drawer, onClick: () => setDrawer(true) },
  ];

  return (
    <PortalContext.Provider value={{ base, assistant }}>
      <div className="flex min-h-screen">
        <aside aria-label={`${subtitle} navigation`} className="hidden md:flex md:w-64 md:flex-col md:border-r md:bg-[color:var(--color-surface)]">
          <Brand subtitle={subtitle} />
          <NavTree base={base} groups={groups} devGroup={devGroup} pathname={pathname} />
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header role="banner" className="flex h-16 items-center justify-between gap-3 border-b bg-[color:var(--color-surface)] px-4 sm:px-6">
            <div className="flex min-w-0 items-center gap-2 sm:gap-3">
              <span className="truncate text-sm font-semibold">{scopeLabel}</span>
              <Badge variant="brand" className="hidden sm:inline-flex">{badge}</Badge>
            </div>
            <PortalSearchBox base={base} className="hidden max-w-md flex-1 lg:block" />
            <div className="flex shrink-0 items-center gap-2 sm:gap-3">
              <div className="hidden flex-col items-end text-xs leading-tight xl:flex">
                <span className="font-medium text-[color:var(--color-text)]">{fullName}</span>
                <span className="text-[color:var(--color-text-muted)]">{email}</span>
              </div>
              <ModeSwitch initialLivemode={livemode} />
              <ThemeToggle />
              <Button variant="secondary" size="sm" onClick={logout} aria-label="Log out">
                <LogOut className="h-4 w-4" /> <span className="hidden sm:inline">Logout</span>
              </Button>
            </div>
          </header>
          <TestModeBanner livemode={livemode} />
          <main role="main" className="flex-1 overflow-y-auto bg-[color:var(--color-surface-muted)] px-4 pb-24 pt-5 sm:px-6 sm:pt-8 md:pb-8">
            <div className="mx-auto max-w-7xl">{children}</div>
          </main>
        </div>

        {/* Phone: a tab bar for the things people do most, and the full menu in a drawer. */}
        <nav aria-label="Quick" className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t bg-[color:var(--color-surface)]/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
          {tabs.map((t) => {
            const Icon = t.icon;
            const body = (
              <span className={cn("flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium",
                t.active ? "text-[color:var(--color-brand)]" : "text-[color:var(--color-text-muted)]")}>
                <Icon className="h-5 w-5" />{t.label}
              </span>
            );
            return t.href
              ? <Link key={t.label} href={t.href} aria-current={t.active ? "page" : undefined}>{body}</Link>
              : <button key={t.label} type="button" onClick={t.onClick} aria-expanded={drawer}>{body}</button>;
          })}
        </nav>
        {drawer && (
          <div className="fixed inset-0 z-50 md:hidden">
            <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setDrawer(false)} />
            <aside aria-label="Menu" className="absolute inset-y-0 left-0 flex w-[82vw] max-w-xs flex-col border-r bg-[color:var(--color-surface)] shadow-2xl">
              <div className="flex items-center border-b">
                <div className="flex-1"><Brand subtitle={subtitle} bare /></div>
                <button type="button" onClick={() => setDrawer(false)} aria-label="Close menu"
                  className="mr-3 grid h-10 w-10 place-items-center rounded-lg text-[color:var(--color-text-muted)] hover:bg-[color:var(--color-surface-muted)]">
                  <X className="h-5 w-5" />
                </button>
              </div>
              <NavTree base={base} groups={groups} devGroup={devGroup} pathname={pathname} onNavigate={() => setDrawer(false)} />
            </aside>
          </div>
        )}
      </div>
    </PortalContext.Provider>
  );
}
