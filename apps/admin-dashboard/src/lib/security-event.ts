// Security events that are not about a phone: a webhook that failed its signature, for one.
// Written to vendor_security_alerts (vendorGateway 0006), the list ops already reviews under
// Reconciliation → Security, and sent to the admin Telegram chats (lib/ops-alert).
//
// Best-effort and never throws: recording an attack must not become a way to break the route
// being attacked. The same event is recorded once per ten minutes, so a caller hammering a
// webhook fills neither the table nor the chat.

import { rows } from "@/lib/pg";
import { raiseAlert } from "@/lib/ops-alert";

export type SecurityRisk = "BAD_SIGNATURE" | "UNVERIFIED_EMAIL";

const TITLE: Record<SecurityRisk, string> = {
  BAD_SIGNATURE: "A webhook failed its signature check",
  UNVERIFIED_EMAIL: "A payment mail failed its sender check and was not acted on",
};

export async function recordSecurityEvent(e: { risk: SecurityRisk; severity?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"; detail: string }): Promise<void> {
  try {
    const detail = e.detail.slice(0, 500);
    const ins = await rows<{ alert_id: string }>("vendorGateway", `
      INSERT INTO vendor_security_alerts (risk_type, severity, detail)
      SELECT $1, $2, $3
       WHERE NOT EXISTS (
         SELECT 1 FROM vendor_security_alerts
          WHERE risk_type = $1 AND detail = $3 AND created_at > now() - interval '10 minutes')
      RETURNING alert_id::text
    `, [e.risk, e.severity ?? "HIGH", detail]);
    if (ins.length)
      await raiseAlert({ key: `security:${e.risk}`, severity: "WARN", title: TITLE[e.risk], body: detail, repeatMinutes: 30 });
  } catch (err) {
    console.warn("[security-event] not recorded:", (err as Error).message);
  }
}
