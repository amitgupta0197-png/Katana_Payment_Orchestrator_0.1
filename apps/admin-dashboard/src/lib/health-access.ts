// Who reads and recomputes actor health (lib/health). Staff only: items may name a TSP or gateway.
import type { Persona } from "@/lib/auth";

export const HEALTH_READ: Persona[] = ["SUPER_ADMIN", "ADMIN", "OPERATOR", "COMPLIANCE", "RISK", "FINANCE", "SUPPORT"];
export const HEALTH_WRITE: Persona[] = ["SUPER_ADMIN", "ADMIN"];
