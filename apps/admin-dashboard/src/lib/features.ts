// Navigation feature flags. Pure: no imports, safe on client and server.
//
// Each flag is ON unless the server's env sets `FEATURE_<NAME>=0` (or "false" / "off").
// The client learns them from GET /api/nav/features (staff session), never from its own env.
//
// These flags only hide MENU ENTRIES (the sidebar section, and for NAV_HUBS the tabbed hubs,
// which fall back to the old flat menu exactly). They do not gate any page or API: every page
// stays reachable by its URL and through ⌘K whatever the flag says. Access to a page is the
// page's and its API's own persona gate, not this file's.

export const FEATURE_NAMES = [
  "PROVIDER_MANAGEMENT",
  "ONBOARDING_JOURNEYS",
  "PAYMENT_FLOWS",
  "MASTER_DATA",
  "NAV_HUBS",
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];
export type Features = Record<FeatureName, boolean>;

/** Every flag on: the default, and what the client assumes until the flags have loaded. */
export const ALL_FEATURES_ON: Features = Object.fromEntries(FEATURE_NAMES.map((n) => [n, true])) as Features;

const OFF = new Set(["0", "false", "off", "no"]);

/** Flags from an env map (pure, for tests); a flag is off only when its env says so. */
export function featuresFrom(env: Record<string, string | undefined>): Features {
  const out = { ...ALL_FEATURES_ON };
  for (const n of FEATURE_NAMES) {
    const v = env[`FEATURE_${n}`];
    if (v !== undefined && OFF.has(v.trim().toLowerCase())) out[n] = false;
  }
  return out;
}

/** Server only: the flags from this process's env. */
export function serverFeatures(): Features {
  return featuresFrom(process.env as Record<string, string | undefined>);
}
