// WORM (write-once / append-only) audit helper.
// BRD §15 + §17: every admin action and KYC decision flows through here so
// the audit trail is tamper-evident (hash-chained) and append-only at the DB.

import { createHash } from "crypto";
import { rows } from "@/lib/pg";

export interface WormAppendInput {
  actorId?: string | null;
  actorEmail?: string | null;
  action: string;          // "provider.kyc.approve" | "merchant.advance" | "submid.terminate"
  resourceType: string;    // "provider" | "merchant" | "sub_mid"
  resourceId: string;
  before?: unknown;
  after?: unknown;
  notes?: string;
}

function canonical(obj: unknown): string {
  if (obj === null || obj === undefined) return "";
  if (typeof obj !== "object") return String(obj);
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[k] = (obj as Record<string, unknown>)[k];
  }
  return JSON.stringify(sorted);
}

export async function wormAppend(input: WormAppendInput): Promise<{ log_id: string; hash: string }> {
  const head = await rows<{ last_hash: string }>("audit",
    "SELECT last_hash FROM worm_audit_chain_head WHERE tenant_id = $1",
    ["tenant-default"]
  ).catch(() => []);
  const prevHash = head[0]?.last_hash ?? "";

  const payload = [
    prevHash, input.actorId ?? "", input.action,
    input.resourceType, input.resourceId,
    canonical(input.before), canonical(input.after), input.notes ?? "",
  ].join("|");
  const hash = createHash("sha256").update(payload).digest("hex");

  const inserted = await rows<{ log_id: string }>("audit", `
    INSERT INTO worm_audit_log
      (tenant_id, actor_id, actor_email, action, resource_type, resource_id,
       before_value, after_value, notes, prev_hash, hash)
    VALUES ('tenant-default', $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)
    RETURNING log_id::text
  `, [
    input.actorId ?? null, input.actorEmail ?? null,
    input.action, input.resourceType, input.resourceId,
    input.before === undefined ? null : JSON.stringify(input.before),
    input.after  === undefined ? null : JSON.stringify(input.after),
    input.notes ?? null, prevHash, hash,
  ]);

  await rows("audit", `
    INSERT INTO worm_audit_chain_head (tenant_id, last_hash, last_log_id, updated_at)
    VALUES ('tenant-default', $1, $2::uuid, now())
    ON CONFLICT (tenant_id) DO UPDATE
       SET last_hash = EXCLUDED.last_hash,
           last_log_id = EXCLUDED.last_log_id,
           updated_at = now()
  `, [hash, inserted[0].log_id]);

  return { log_id: inserted[0].log_id, hash };
}

// Verify chain integrity from the start. Returns first broken index, or -1 if clean.
export async function wormVerify(): Promise<{ ok: boolean; broken_at?: number; count: number }> {
  const all = await rows<{ log_id: string; prev_hash: string; hash: string; actor_id: string|null;
                          action: string; resource_type: string; resource_id: string;
                          before_value: unknown; after_value: unknown; notes: string|null }>(
    "audit",
    `SELECT log_id::text, prev_hash, hash, actor_id, action, resource_type, resource_id,
            before_value, after_value, notes
       FROM worm_audit_log
      WHERE tenant_id = 'tenant-default'
      ORDER BY created_at ASC, log_id ASC`,
    []
  );
  let prev = "";
  for (let i = 0; i < all.length; i++) {
    const r = all[i];
    const payload = [
      prev, r.actor_id ?? "", r.action, r.resource_type, r.resource_id,
      canonical(r.before_value), canonical(r.after_value), r.notes ?? "",
    ].join("|");
    const expected = createHash("sha256").update(payload).digest("hex");
    if (expected !== r.hash || r.prev_hash !== prev) {
      return { ok: false, broken_at: i, count: all.length };
    }
    prev = r.hash;
  }
  return { ok: true, count: all.length };
}
