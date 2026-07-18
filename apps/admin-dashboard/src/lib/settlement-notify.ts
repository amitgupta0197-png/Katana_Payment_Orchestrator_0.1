// Outbound settlement notifications (BRD §7). Fire-and-forget: never blocks or fails
// the transition that triggered it. WEBHOOK posts a signed JSON event (same HMAC scheme
// as the checkout status callback — x-katana-signature over the raw body, so receivers
// verify with their SESSION-side shared secret). EMAIL is stored-but-dormant until SMTP
// credentials are configured (no mailer dependency in this deployment yet).

import { rows } from "@/lib/pg";
import { signPayload } from "@/lib/fifo-notify";
import { safeFetch } from "@/lib/safe-fetch";

export interface SettlementNotifyEvent {
  event: string;                 // e.g. settlement.paid
  request_ref: string | null;
  settlement_id: string;
  from_status: string | null;
  to_status: string;
  actor_role: string;
  merchant_key: string;
  amount: number | null;         // gross
  net_amount: number | null;
  settle_mode: string | null;
  utr?: string | null;
  tx_hash?: string | null;
  remarks?: string | null;
  at: string;                    // ISO timestamp
}

export async function notifySettlementEvent(providerId: string, ev: SettlementNotifyEvent): Promise<void> {
  try {
    const channels = await rows<{ kind: string; target: string }>("provider", `
      SELECT kind, target FROM provider_notification_channels
       WHERE provider_id = $1::uuid AND enabled
    `, [providerId]).catch(() => []);
    if (!channels.length) return;

    const body = JSON.stringify(ev);
    const sig = signPayload(body);
    for (const c of channels) {
      if (c.kind !== "WEBHOOK") continue;   // EMAIL: dormant until SMTP is configured
      // 5s cap; failures are logged and dropped — the dashboard feed remains the
      // reliable channel, webhooks are best-effort push.
      safeFetch(c.target, {
        method: "POST",
        headers: { "content-type": "application/json", "x-katana-signature": sig, "x-katana-event": ev.event },
        body,
      }).catch((e) => console.warn(`settlement webhook ${c.target} failed:`, e?.message ?? e));
    }
  } catch (e) { console.warn("notifySettlementEvent error:", (e as Error).message); }
}
