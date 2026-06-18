"use client";

// React hook over /api/me/access. Cached for the session; flip a permission
// in the matrix UI and the next page-nav rehydrates. For CTA gating use
// useCan(moduleCode, "create" | "update" | ...).

import { useQuery } from "@tanstack/react-query";
import type { Rights, Op } from "./access";
import type { Persona } from "./auth";

interface AccessResponse { persona: Persona; rights: Record<string, Rights> }

export function useAccess() {
  return useQuery({
    queryKey: ["me:access"],
    queryFn: async () => (await fetch("/api/me/access").then((r) => r.json())) as AccessResponse,
    staleTime: 5 * 60_000,
  });
}

const COL_FOR: Record<Op, keyof Rights> = {
  create: "can_create",
  read: "can_read",
  update: "can_update",
  delete: "can_delete",
  admin: "can_admin",
};

// useCan — returns false until the query loads; pair with hidden/disabled
// affordances so the UI doesn't flash a CTA the user can't use.
//
// SUPER_ADMIN bypass: if the persona is SUPER_ADMIN and the module isn't in
// the matrix yet (e.g. a new feature ships before the matrix row is seeded),
// default to true. Mirrors the server-side bypass in lib/access.ts → can().
export function useCan(moduleCode: string, op: Op): boolean {
  const q = useAccess();
  if (!q.data) return false;
  const row = q.data.rights[moduleCode];
  if (!row) return q.data.persona === "SUPER_ADMIN";
  return row[COL_FOR[op]];
}
