// Maker-Checker requests (providerservice_db maker_checker_requests, provider 0002).
//
// A change that needs a second person is raised here by its maker and decided on the
// Maker-Checker page (/admin/maker-checker, `app/api/admin/maker-checker`). The checker must be
// someone else. What an approval DOES is registered per action in lib/maker-checker-actions;
// a feature that adds an action adds it there. The queue's data model is unchanged: `payload`
// carries what the action needs, plus `summary`, the one line the page shows.

import { rows } from "@/lib/pg";
import { wormAppend } from "@/lib/worm";

export interface Maker { id: string; email: string }

export interface ApprovalRequest {
  resourceType: string;
  resourceId: string;
  action: string;
  /** What the approval needs. `summary` is added for the page. */
  payload: Record<string, unknown>;
  summary: string;
  maker: Maker;
  notes?: string;
}

export class PendingRequestError extends Error {
  constructor(public requestId: string) { super("a request for this is already waiting for a checker"); }
}

/** The PENDING request for this resource and action, if one is waiting. */
export async function pendingRequest(resourceType: string, resourceId: string, action: string): Promise<string | null> {
  const r = await rows<{ request_id: string }>("provider", `
    SELECT request_id::text FROM maker_checker_requests
     WHERE resource_type = $1 AND resource_id = $2 AND action = $3 AND status = 'PENDING'
     ORDER BY created_at DESC LIMIT 1
  `, [resourceType, resourceId, action]);
  return r[0]?.request_id ?? null;
}

/**
 * Raise a request. Refuses (PendingRequestError) when the same action on the same resource is
 * already waiting, so a double click does not queue it twice.
 */
export async function requestApproval(a: ApprovalRequest): Promise<string> {
  const open = await pendingRequest(a.resourceType, a.resourceId, a.action);
  if (open) throw new PendingRequestError(open);
  const r = await rows<{ request_id: string }>("provider", `
    INSERT INTO maker_checker_requests (resource_type, resource_id, action, payload, maker_id, maker_email)
    VALUES ($1, $2, $3, $4::jsonb, $5, $6)
    RETURNING request_id::text
  `, [a.resourceType, a.resourceId, a.action, JSON.stringify({ ...a.payload, summary: a.summary, ...(a.notes ? { maker_notes: a.notes } : {}) }),
      a.maker.id, a.maker.email]);
  await wormAppend({
    actorId: a.maker.id, actorEmail: a.maker.email, action: `${a.action}.requested`,
    resourceType: a.resourceType, resourceId: a.resourceId, after: { request_id: r[0].request_id, ...a.payload }, notes: a.notes,
  }).catch(() => {});
  return r[0].request_id;
}

/** Withdraw a PENDING request (its maker changed their mind, or what it was for is gone). */
export async function withdrawRequest(requestId: string, by: Maker, why: string): Promise<boolean> {
  const r = await rows("provider", `
    UPDATE maker_checker_requests SET status = 'EXPIRED', checker_id = $2, checker_email = $3, decision_notes = $4, decided_at = now()
     WHERE request_id = $1::uuid AND status = 'PENDING' RETURNING 1
  `, [requestId, by.id, by.email, why]);
  return r.length > 0;
}
