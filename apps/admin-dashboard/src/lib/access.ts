// User Access Management — reads iamservice_db.uam_module_access and exposes
// per-persona CRUD/admin bitmasks to both route handlers and React components.
//
// The matrix is the single source of truth for what each persona can do per
// module. lib/scope.ts still enforces row-level scoping; this layer enforces
// "does this persona get this verb on this module at all". SUPER_ADMIN can
// edit any cell at runtime via /admin/access.

import { rows } from "./pg";
import type { Persona } from "./auth";

export type Op = "create" | "read" | "update" | "delete" | "admin";

export interface Rights {
  can_create: boolean;
  can_read: boolean;
  can_update: boolean;
  can_delete: boolean;
  can_admin: boolean;
}

export interface MatrixCell extends Rights {
  module_code: string;
  display_name: string;
  area: string;
  persona: Persona;
  updated_at: string;
  updated_by: string;
}

export interface ModuleMeta {
  module_code: string;
  display_name: string;
  area: string;
  description: string;
}

const COL_FOR: Record<Op, keyof Rights> = {
  create: "can_create",
  read: "can_read",
  update: "can_update",
  delete: "can_delete",
  admin: "can_admin",
};

export async function listModules(): Promise<ModuleMeta[]> {
  return rows<ModuleMeta>(
    "iam",
    `SELECT module_code, display_name, area, COALESCE(description,'') AS description
       FROM uam_modules ORDER BY area, display_name`,
  ).catch(() => []);
}

// Full matrix — SUPER_ADMIN reads all rows; PROVIDER/MERCHANT see only their
// own persona row (defense-in-depth — UI also hides edit affordances).
export async function getMatrix(persona: Persona): Promise<MatrixCell[]> {
  if (persona === "SUPER_ADMIN") {
    return rows<MatrixCell>(
      "iam",
      `SELECT a.module_code, m.display_name, m.area, a.persona,
              a.can_create, a.can_read, a.can_update, a.can_delete, a.can_admin,
              a.updated_at, COALESCE(a.updated_by,'') AS updated_by
         FROM uam_module_access a
         JOIN uam_modules m USING (module_code)
        ORDER BY m.area, m.display_name, a.persona`,
    ).catch(() => []);
  }
  return rows<MatrixCell>(
    "iam",
    `SELECT a.module_code, m.display_name, m.area, a.persona,
            a.can_create, a.can_read, a.can_update, a.can_delete, a.can_admin,
            a.updated_at, COALESCE(a.updated_by,'') AS updated_by
       FROM uam_module_access a
       JOIN uam_modules m USING (module_code)
      WHERE a.persona = $1
      ORDER BY m.area, m.display_name`,
    [persona],
  ).catch(() => []);
}

// Per-persona rights map keyed by module_code — used by useAccess() on the
// client to gate CTAs without an extra round-trip per check.
export async function rightsFor(persona: Persona): Promise<Record<string, Rights>> {
  const r = await rows<{ module_code: string } & Rights>(
    "iam",
    `SELECT module_code, can_create, can_read, can_update, can_delete, can_admin
       FROM uam_module_access WHERE persona = $1`,
    [persona],
  ).catch(() => []);
  const out: Record<string, Rights> = {};
  for (const row of r) {
    out[row.module_code] = {
      can_create: row.can_create,
      can_read: row.can_read,
      can_update: row.can_update,
      can_delete: row.can_delete,
      can_admin: row.can_admin,
    };
  }
  return out;
}

export async function can(persona: Persona, module: string, op: Op): Promise<boolean> {
  if (persona === "SUPER_ADMIN") {
    // Fast path — super admin defaults to true unless a row explicitly says false.
    const r = await rows<Rights>(
      "iam",
      `SELECT can_create, can_read, can_update, can_delete, can_admin
         FROM uam_module_access WHERE persona = 'SUPER_ADMIN' AND module_code = $1`,
      [module],
    ).catch(() => []);
    if (!r.length) return true;
    return r[0][COL_FOR[op]];
  }
  const r = await rows<Rights>(
    "iam",
    `SELECT can_create, can_read, can_update, can_delete, can_admin
       FROM uam_module_access WHERE persona = $1 AND module_code = $2`,
    [persona, module],
  ).catch(() => []);
  if (!r.length) return false;
  return r[0][COL_FOR[op]];
}

export async function setCell(
  module: string,
  persona: Persona,
  rights: Partial<Rights>,
  updatedBy: string,
): Promise<MatrixCell> {
  // UPSERT: row may not exist yet for newly seeded modules.
  const sets: string[] = [];
  const params: unknown[] = [module, persona];
  let i = 3;
  for (const [k, v] of Object.entries(rights)) {
    sets.push(`${k} = $${i++}`);
    params.push(v);
  }
  if (!sets.length) throw new Error("no rights to update");
  params.push(updatedBy);
  const r = await rows<MatrixCell>(
    "iam",
    `INSERT INTO uam_module_access (module_code, persona, ${Object.keys(rights).join(",")}, updated_by)
     VALUES ($1, $2, ${Object.keys(rights).map((_, k) => `$${k + 3}`).join(",")}, $${i})
     ON CONFLICT (module_code, persona) DO UPDATE SET
       ${sets.join(", ")},
       updated_at = now(),
       updated_by = EXCLUDED.updated_by
     RETURNING module_code, persona, can_create, can_read, can_update, can_delete, can_admin,
               updated_at, COALESCE(updated_by,'') AS updated_by,
               (SELECT display_name FROM uam_modules WHERE module_code = $1) AS display_name,
               (SELECT area         FROM uam_modules WHERE module_code = $1) AS area`,
    params,
  );
  return r[0];
}
