// Who must have two-factor, and whether that is enforced. Kept free of database and Node
// imports so the middleware (Edge runtime) and the server share one definition.
//
// With FIFO_MFA_ENFORCE=true a staff session that did not pass a code can reach only the
// two-factor set-up page and its API: the middleware sends everything else there, and `gate`
// (lib/scope.ts) refuses the rest. Nobody is locked out: a user who has not enrolled signs in
// with their password and is taken straight to set-up. A lost authenticator is reset by a
// Super Admin (Admin → Users → the user → Danger zone).

import type { Persona } from "@/lib/auth";

// Every staff role. PROVIDER / MERCHANT / BANKER are merchants' own logins and may enrol, but
// are not made to.
export const SENSITIVE_ROLES: Persona[] = ["SUPER_ADMIN", "ADMIN", "OPERATOR", "FINANCE", "RISK", "COMPLIANCE", "SUPPORT"];
export const MFA_ENFORCED = (process.env.FIFO_MFA_ENFORCE ?? "false") === "true";

export function isSensitiveRole(p: Persona): boolean { return SENSITIVE_ROLES.includes(p); }

/** True when this session must set two-factor up before it may do anything else. */
export function mfaSetupRequired(s: { persona: Persona; mfa?: boolean }, enforced: boolean = MFA_ENFORCED): boolean {
  return enforced && isSensitiveRole(s.persona) && !s.mfa;
}

// What such a session may still reach.
export const MFA_SETUP_UI = "/security";
export const MFA_SETUP_API = ["/api/v1/mfa", "/api/auth", "/api/me/access", "/api/me/logout-all"];
