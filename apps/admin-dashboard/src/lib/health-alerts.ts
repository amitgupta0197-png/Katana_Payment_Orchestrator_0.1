// What the actor-health cron tells people (lib/ops-alert): ONE alert for all LIVE actors that are
// RED or BLOCKED (key `health:alarming`, the worst 15 listed, repeated at most once a day), resolved
// when none is left; and a digest of live AMBER actors, sent at most once per India day from 09:00
// IST. Every actor's own state is on the health pages, not in the chat.
//
// The first release (2026-10-04) raised one alert per actor: 77 messages at once, because every
// live banker missed the TSP / MID items that had just been added. Those per-actor alerts are
// closed here without a message.
// Staff only (the admin chats), so labels may name a TSP.

import { rows } from "@/lib/pg";
import { raiseAlert, resolveAlert, setAlert } from "@/lib/ops-alert";
import { computeAll } from "@/lib/health-store";
import { isAlarming, istHour, type HealthResult } from "@/lib/health";

const TYPE_WORD = { TSP: "TSP", BANKER: "Banker", MERCHANT: "Merchant", INTEGRATION: "Integration" } as const;
export const alertKey = (r: Pick<HealthResult, "type" | "id">) => `health:${r.type}:${r.id}`;
const DIGEST_KEY = "health:amber-digest";
const ALARMING_KEY = "health:alarming";

function missingList(r: HealthResult): string {
  return r.items.filter((i) => i.state === "MISSING").map((i) => `${i.critical ? "[critical] " : ""}${i.label}`).slice(0, 6).join("; ");
}

export async function runActorHealth(now = new Date()) {
  const { results, counts } = await computeAll();
  const bad = results.filter((r) => r.live && isAlarming(r.band));

  // Per-actor alerts from before: closed silently (resolveAlert would post one message each).
  const closed = await rows<{ n: number }>("audit", `
    WITH c AS (UPDATE ops_alerts SET resolved_at = now()
                WHERE alert_key LIKE 'health:%' AND alert_key NOT IN ($1, $2) AND resolved_at IS NULL RETURNING 1)
    SELECT count(*)::int AS n FROM c`, [ALARMING_KEY, DIGEST_KEY]).catch(() => [{ n: 0 }]);
  const resolved = closed[0]?.n ?? 0;

  const worst = [...bad].sort((a, b) => (a.band === "BLOCKED" ? -1 : 0) - (b.band === "BLOCKED" ? -1 : 0) || a.score - b.score);
  const blocked = bad.filter((r) => r.band === "BLOCKED").length;
  await setAlert(bad.length > 0, {
    key: ALARMING_KEY, severity: blocked ? "CRITICAL" : "WARN", repeatMinutes: 24 * 60,
    title: `${bad.length} live actor${bad.length === 1 ? " is" : "s are"} RED or BLOCKED (${blocked} blocked)`,
    body: worst.slice(0, 15).map((r) => `${TYPE_WORD[r.type]} ${r.label}: ${r.band}${r.band === "BLOCKED" ? "" : ` ${r.score}`}, missing ${missingList(r) || "—"}`).join("\n")
      + (bad.length > 15 ? `\n…and ${bad.length - 15} more` : "") + "\nAll of them: the Health alerts card on the Operations console.",
  });

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
