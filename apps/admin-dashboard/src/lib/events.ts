// Event-bus publisher (BRD §16). Cross-module state changes write here so
// dashboard / reconciliation / AI / audit can consume independently.
//
// Writes are best-effort: a failure to publish must NOT break the calling
// transaction. Callers should `await publish(...)` but a thrown error from
// the DB is swallowed so producers don't tear down on event-stream issues.

import { rows } from "@/lib/pg";

export type EventType =
  | "merchant.created"
  | "submid.status_changed"
  | "payment.created"
  | "route.selected"
  | "callback.received"
  | "payment.succeeded"
  | "settlement.calculated"
  | "reconciliation.break_opened"
  | "risk.alert"
  | "merchant.kyc_decided"
  // A provider row removed outright (housekeeping: onboarding tests, duplicates, typo'd codes).
  // Distinct from merchant.status.terminate, which keeps the record. The event IS the audit
  // trail here: provider_audit_logs cascades away with the row it belongs to.
  | "provider.deleted"
  | "merchant.integration.updated"
  | "maker_checker.requested"
  | "maker_checker.decided"
  | "auth.session_started"
  | "auth.session_ended";

export type Producer =
  | "merchant_onboarding"
  | "sub_mid_engine"
  | "payment_core"
  | "routing_engine"
  | "callback_engine"
  | "settlement_engine"
  | "reconciliation"
  | "risk_engine"
  | "provider_mgmt"
  | "auth"
  | "admin_console";

export interface PublishInput {
  eventType: EventType;
  producer: Producer;
  entityType: string;
  entityId: string;
  actorId?: string | null;
  payload?: Record<string, unknown>;
}

export async function publish(e: PublishInput): Promise<void> {
  try {
    await rows("audit", `
      INSERT INTO event_stream (event_type, producer, entity_type, entity_id, actor_id, payload)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
    `, [
      e.eventType, e.producer, e.entityType, e.entityId,
      e.actorId ?? null, JSON.stringify(e.payload ?? {}),
    ]);
  } catch (err) {
    // Best-effort: do not propagate.
    console.warn("[events] publish failed:", (err as Error).message);
  }
}
