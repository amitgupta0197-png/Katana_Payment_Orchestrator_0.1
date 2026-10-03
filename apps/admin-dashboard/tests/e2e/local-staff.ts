// A staff login for the LOCAL database only, so the end-to-end tests (and a person checking the
// screens on localhost) can sign in. The password is generated once and kept in .env.local
// (E2E_STAFF_PASSWORD), which is not committed. Refuses any database that is not local.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { rows } from "@/lib/pg";
import { hashPassword } from "@/lib/password";

export const E2E_STAFF_EMAIL = "e2e-staff@katana.test";
const HOST = process.env.PG_HOST ?? "localhost";
export const LOCAL = ["localhost", "127.0.0.1", "::1"].includes(HOST);

function password(): string {
  if (process.env.E2E_STAFF_PASSWORD) return process.env.E2E_STAFF_PASSWORD;
  const file = ".env.local";
  const saved = existsSync(file) ? /^E2E_STAFF_PASSWORD=(.+)$/m.exec(readFileSync(file, "utf8"))?.[1] : null;
  if (saved) return saved;
  const made = randomBytes(18).toString("base64url");
  appendFileSync(file, `\n# Local staff login for tests/e2e (${E2E_STAFF_EMAIL}). Local database only.\nE2E_STAFF_PASSWORD=${made}\n`);
  return made;
}

/** Create the local staff user if it is missing, set its password, and return the sign-in pair. */
export async function ensureLocalStaff(): Promise<{ email: string; password: string }> {
  if (!LOCAL) throw new Error(`refusing to create a staff login on a non-local database (${HOST})`);
  const pw = password();
  const u = await rows<{ id: string }>("auth", `
    INSERT INTO users (id, email, full_name, password_hash, status)
    VALUES (gen_random_uuid(), $1, 'E2E Staff', $2, 'active')
    ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, status = 'active'
    RETURNING id::text
  `, [E2E_STAFF_EMAIL, hashPassword(pw)]);
  await rows("iam", `
    INSERT INTO user_personas (id, user_id, persona_kind, scope_id, scope_label, is_primary, granted_by)
    SELECT gen_random_uuid(), $1::uuid, 'SUPER_ADMIN', NULL, 'Katana (local e2e)', true, 'e2e'
    WHERE NOT EXISTS (SELECT 1 FROM user_personas WHERE user_id = $1::uuid)
  `, [u[0].id]);
  return { email: E2E_STAFF_EMAIL, password: pw };
}
