// Who may create, regenerate or see the Salt of a banker's Key + Salt (checkout credentials).
//
// PURE, so screens and routes share one list. The banker itself (banker portal Integration page,
// /api/me/integration) and these staff roles manage Keys. A merchant (PROVIDER) never does: it is
// shown each banker's Key, never the Salt or a hint of it, and cannot make or regenerate one.
// The Starter Kit is unchanged (lib/starter-kit: the test Key + Salt only, never the live Salt).

import type { Persona } from "@/lib/auth";

export const KEY_ADMINS: readonly Persona[] = ["SUPER_ADMIN", "ADMIN"];

export const managesKeys = (persona: Persona | null | undefined): boolean => !!persona && KEY_ADMINS.includes(persona);
