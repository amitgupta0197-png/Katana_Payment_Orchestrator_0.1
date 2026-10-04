// What the actor-health cron tells people (lib/ops-alert): one alert per LIVE actor that is RED
// or BLOCKED (key `health:<type>:<id>`), resolved when it recovers or stops being live; and a
// digest of live AMBER actors, sent at most once per India day from 09:00 IST.
// Staff only (the admin chats), so labels may name a TSP.

import { openAlerts, raiseAlert, resolveAlert, setAlert } from "@/lib/ops-alert";
import { computeAll } from "@/lib/health-store";
import { isAlarming, istHour, type HealthResult } from "@/lib/health";

const TYPE_WORD = { TSP: "TSP", BANKER: "Banker", MERCHANT: "Merchant", INTEGRATION: "Integration" } as const;
export const alertKey = (r: Pick<HealthResult, "type" | "id">) => `health:${r.type}:${r.id}`;
const DIGEST_KEY = "health:amber-digest";

function missingList(r: HealthResult): string {
  return r.items.filter((i) => i.state === "MISSING").map((i) => `${i.critical ? "[critical] " : ""}${i.label}`).slice(0, 6).join("; ");
}

export async function runActorHealth(now = new Date()) {
  const { results, counts } = await computeAll();
  const bad = results.filter((r) => r.live && isAlarming(r.band));
  const badKeys = new Set(bad.map(alertKey));

  for (const r of bad)
    await setAlert(true, {
      key: alertKey(r), severity: r.band === "BLOCKED" ? "CRITICAL" : "WARN", repeatMinutes: 360,
      title: `${TYPE_WORD[r.type]} ${r.label} is ${r.band}${r.band === "BLOCKED" ? "" : ` (${r.score})`}`,
      body: `Missing: ${missingList(r) || "—"}. Health: /api/health-checks/${r.type}/${encodeURIComponent(r.id)}`,
    });

  // Recovered, or no longer live: close what is still open.
  let resolved = 0;
  for (const a of await openAlerts())
    if (a.alert_key.startsWith("health:") && a.alert_key !== DIGEST_KEY && !badKeys.has(a.alert_key)) {
      await resolveAlert(a.alert_key, "Health is back to GREEN / AMBER, or the actor is no longer live.");
      resolved++;
    }

  const amber = results.filter((r) => r.live && r.band === "AMBER");
  let digest = false;
  if (!amber.length) await resolveAlert(DIGEST_KEY);
  else if (istHour(now) >= 9) {
    // 23 h between sends: never twice in one India day, and it drifts back to 09:00.
    digest = (await raiseAlert({
      key: DIGEST_KEY, severity: "INFO", repeatMinutes: 23 * 60,
      title: `${amber.length} live actor${amber.length === 1 ? " is" : "s are"} AMBER`,
      body: amber.slice(0, 15).map((r) => `${TYPE_WORD[r.type]} ${r.label} (${r.score}): ${missingList(r)}`).join("\n")
        + (amber.length > 15 ? `\n…and ${amber.length - 15} more` : ""),
    })).sent;
  }
  return { counts, alarming: bad.length, resolved, amber: amber.length, digest_sent: digest };
}
