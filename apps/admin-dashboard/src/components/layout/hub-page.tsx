"use client";

// A hub: existing pages re-housed as tabs (/hub/*, lib/nav navHubs). The tab is in ?tab=,
// each tab renders the EXISTING page component unchanged, and a tab the persona's menu would
// not show is not offered. Every tab's own URL keeps working; "Open on its own page" links to it.
// Breadcrumb: Section › Hub › Tab.

import { Suspense, type ComponentType } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronRight, ExternalLink } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { hubByHref, hubTabs } from "@/lib/nav";
import { useNav } from "./use-nav";

/** The existing page each tab key renders. A tab without one links out to its page. */
export type HubComponents = Record<string, ComponentType | undefined>;

function HubBody({ href, components }: { href: string; components: HubComponents }) {
  const hub = hubByHref(href);
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { persona, visible, loading } = useNav();
  if (!hub) return null;
  // Wait for the session: until then useNav assumes SUPER_ADMIN, which would offer every tab.
  if (loading) return <p className="text-sm text-[color:var(--color-text-muted)]">Loading…</p>;

  const tabs = hubTabs(hub, visible, persona);
  const asked = params.get("tab");
  const tab = tabs.find((t) => t.key === asked) ?? tabs[0];

  const select = (key: string) => {
    const next = new URLSearchParams(params.toString());
    next.set("tab", key);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };

  if (!tab) {
    return (
      <p className="text-sm text-[color:var(--color-text-muted)]">
        {loading ? "Loading…" : "Nothing in this section is available to you."}
      </p>
    );
  }
  const Page = components[tab.key];

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-3 flex flex-wrap items-center gap-1 text-xs text-[color:var(--color-text-muted)]">
        <span>{hub.group}</span>
        <ChevronRight className="h-3 w-3" aria-hidden />
        <Link href={hub.href} className="hover:text-[color:var(--color-text)]">{hub.label}</Link>
        <ChevronRight className="h-3 w-3" aria-hidden />
        <span className="font-medium text-[color:var(--color-text)]">{tab.label}</span>
        <Link href={tab.href} className="ml-auto inline-flex items-center gap-1 hover:text-[color:var(--color-text)]" title="Open this page on its own">
          {tab.href} <ExternalLink className="h-3 w-3" aria-hidden />
        </Link>
      </nav>
      {tabs.length > 1 && (
        <Tabs value={tab.key} onValueChange={select} className="mb-6">
          <TabsList>
            {tabs.map((t) => <TabsTrigger key={t.key} value={t.key}>{t.label}</TabsTrigger>)}
          </TabsList>
        </Tabs>
      )}
      {Page ? (
        <Page key={tab.key} />
      ) : (
        <p className="text-sm">
          This page opens on its own: <Link href={tab.href} className="font-medium text-[color:var(--color-brand)] underline">{tab.label}</Link>
        </p>
      )}
    </>
  );
}

export function HubPage({ href, components }: { href: string; components: HubComponents }) {
  // useSearchParams (here and in some embedded pages) needs a Suspense boundary.
  return (
    <Suspense fallback={null}>
      <HubBody href={href} components={components} />
    </Suspense>
  );
}
