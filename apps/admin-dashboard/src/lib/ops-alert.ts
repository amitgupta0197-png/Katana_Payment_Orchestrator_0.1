// Ops alerts: a condition that needs a person, sent to the admin Telegram chats once and then
// again only after a quiet period, however often it is checked.
//
// The row in ops_alerts (audit 0006) is the memory: raiseAlert() on a condition that is still
// open only bumps its last-seen time, and resolveAlert() closes it so the next occurrence is
// sent as new. Both are best-effort and never throw — an alert that cannot be recorded or sent
// must not break the work that noticed the condition.
//
// These go to Katana staff only (lib/telegram's admin allowlist), so they may name a gateway.
//
// An alert raised with `email: true` is also mailed to the operations team (lib/ops-email) at
// the same moments: when it is sent and when it is resolved. Mail that is not configured, or
// that fails, changes nothing else.

import { rows } from "@/lib/pg";
import { broadcastToAdmins, esc, telegramConfigured } from "@/lib/telegram";
import { sendOpsEmail } from "@/lib/ops-email";

export type AlertSeverity = "INFO" | "WARN" | "CRITICAL";

export interface AlertInput {
  /** What the alert is about, e.g. `circuit:PAYU`. One open alert per key. */
  key: string;
  severity: AlertSeverity;
  title: string;
  body?: string;
  /** Minutes before a still-open alert is sent again. */
  repeatMinutes?: number;
  /** Also mail the operations team (lib/ops-email). */
  email?: boolean;
}

const ICON: Record<AlertSeverity, string> = { INFO: "ℹ️", WARN: "⚠️", CRITICAL: "🚨" };

/** Record the condition and send it if it is new, was resolved, or has been quiet long enough. */
export async function raiseAlert(a: AlertInput): Promise<{ sent: boolean }> {
  try {
    const repeat = a.repeatMinutes ?? 60;
    // The write itself decides whether this call sends: it stamps last_sent_at with its own
    // time only when the alert is new, was resolved, or has been quiet long enough. Of two
    // checks at the same moment the second sees the first one's stamp and does not send.
    const r = await rows<{ send: boolean }>("audit", `
      INSERT INTO ops_alerts (alert_key, severity, title, body, last_sent_at)
      VALUES ($1, $2, $3, $4, now())
      ON CONFLICT (alert_key) DO UPDATE SET
        severity = EXCLUDED.severity, title = EXCLUDED.title, body = EXCLUDED.body,
        last_seen_at = now(), seen_count = ops_alerts.seen_count + 1,
        first_seen_at = CASE WHEN ops_alerts.resolved_at IS NOT NULL THEN now() ELSE ops_alerts.first_seen_at END,
        resolved_at = NULL,
        last_sent_at = CASE
          WHEN ops_alerts.resolved_at IS NOT NULL OR ops_alerts.last_sent_at IS NULL
            OR ops_alerts.last_sent_at < now() - make_interval(mins => $5::int)
          THEN now() ELSE ops_alerts.last_sent_at END
      RETURNING (last_sent_at = now()) AS send
    `, [a.key, a.severity, a.title, a.body ?? null, repeat]);
    if (!r[0]?.send) return { sent: false };
    const mailed = a.email ? await sendOpsEmail(`[Katana ${a.severity}] ${a.title}`, `${a.title}\n\n${a.body ?? ""}`.trim()) : false;
    if (!telegramConfigured()) return { sent: mailed };
    await broadcastToAdmins(`${ICON[a.severity]} <b>${esc(a.title)}</b>${a.body ? `\n${esc(a.body)}` : ""}`);
    return { sent: true };
  } catch (err) {
    console.warn("[ops-alert] raise failed:", (err as Error).message);
    return { sent: false };
  }
}

/** The condition no longer holds. Says so once, if the alert was open. */
export async function resolveAlert(key: string, note?: string, opts: { email?: boolean } = {}): Promise<{ resolved: boolean }> {
  try {
    const r = await rows<{ title: string }>("audit", `
      UPDATE ops_alerts SET resolved_at = now() WHERE alert_key = $1 AND resolved_at IS NULL RETURNING title
    `, [key]);
    if (!r.length) return { resolved: false };
    if (opts.email) await sendOpsEmail(`[Katana resolved] ${r[0].title}`, `Resolved: ${r[0].title}${note ? `\n\n${note}` : ""}`);
    if (telegramConfigured()) await broadcastToAdmins(`✅ <b>Resolved: ${esc(r[0].title)}</b>${note ? `\n${esc(note)}` : ""}`);
    return { resolved: true };
  } catch (err) {
    console.warn("[ops-alert] resolve failed:", (err as Error).message);
    return { resolved: false };
  }
}

/** Raise when `on`, resolve when not: for a check that runs on a schedule. */
export async function setAlert(on: boolean, a: AlertInput): Promise<void> {
  if (on) await raiseAlert(a); else await resolveAlert(a.key, undefined, { email: a.email });
}

export interface OpenAlert { alert_key: string; severity: AlertSeverity; title: string; body: string | null; first_seen_at: string; last_seen_at: string }

export async function openAlerts(): Promise<OpenAlert[]> {
  return rows<OpenAlert>("audit", `
    SELECT alert_key, severity, title, body, first_seen_at, last_seen_at
      FROM ops_alerts WHERE resolved_at IS NULL ORDER BY first_seen_at ASC LIMIT 200
  `).catch(() => []);
}
