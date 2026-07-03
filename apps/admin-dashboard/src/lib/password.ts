// Real password hashing for login auth. Uses Node's built-in scrypt so there is
// no native dependency. Stored format: "scrypt$<salt-hex>$<derived-key-hex>".
//
// Backward compatibility: accounts seeded before real passwords existed have a
// null / "demo-mode" password_hash. isRealHash() lets callers fall back to the
// shared DEMO_PASSWORD for those until they set a real password.

import { scryptSync, randomBytes, timingSafeEqual } from "crypto";

const PREFIX = "scrypt";
const KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const dk = scryptSync(password, salt, KEYLEN).toString("hex");
  return `${PREFIX}$${salt}$${dk}`;
}

export function isRealHash(stored: string | null | undefined): boolean {
  return !!stored && stored.startsWith(`${PREFIX}$`);
}

export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!isRealHash(stored)) return false;
  const [, salt, dk] = stored!.split("$");
  const expected = Buffer.from(dk, "hex");
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// A readable one-time initial password an admin shares with a new merchant.
export function generatePassword(): string {
  return `Ktn-${randomBytes(4).toString("hex")}`;
}
