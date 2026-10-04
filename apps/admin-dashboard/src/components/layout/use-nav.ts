"use client";

// The menu a session sees: persona (/api/auth/me), nav feature flags and Access Matrix read
// rights (/api/nav/features, staff only), resolved by lib/nav personaNav. Shared by the
// sidebar, the ⌘K search and the hub pages so all three agree on what is visible.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { navItems, personaNav, type NavAccess, type NavItem, type NavPersona } from "@/lib/nav";
import { ALL_FEATURES_ON, type Features } from "@/lib/features";

const STAFF = new Set<NavPersona>(["SUPER_ADMIN", "ADMIN", "OPERATOR", "COMPLIANCE", "FINANCE", "RISK", "SUPPORT"]);

export function useNav(): { persona: NavPersona; features: Features; visible: NavItem[]; loading: boolean } {
  const me = useQuery({
    queryKey: ["me:persona"],
    queryFn: async () => (await fetch("/api/auth/me").then((r) => r.json())) as { persona: NavPersona },
    staleTime: 5 * 60_000,
  });
  // Render the full superset while the query is in flight so the menu never flashes empty.
  const persona: NavPersona = me.data?.persona ?? "SUPER_ADMIN";
  const staff = STAFF.has(persona);
  const nav = useQuery({
    queryKey: ["nav:features"],
    enabled: !!me.data && staff,
    queryFn: async () => {
      const r = await fetch("/api/nav/features");
      if (!r.ok) return null;
      return (await r.json()) as { features: Features; access: NavAccess };
    },
    staleTime: 5 * 60_000,
  });
  const features = nav.data?.features ?? ALL_FEATURES_ON;
  const access = nav.data?.access ?? null;
  const visible = useMemo(() => personaNav(navItems, persona, { access, features }), [persona, access, features]);
  return { persona, features, visible, loading: me.isLoading || (staff && nav.isLoading) };
}
