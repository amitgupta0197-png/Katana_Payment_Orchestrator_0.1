// Compliance case management (Katana BRD §23). A case bundles notes + evidence
// references and can place its linked order on HOLD.

import { rows } from "@/lib/pg";
import { randomBytes } from "crypto";
import { transition } from "@/lib/fifo";

export async function createCase(input: {
  subject: string; merchantId?: string; orderRef?: string; severity?: string; openedBy?: string;
}): Promise<{ id: string; case_ref: string }> {
  const ref = "CASE-" + randomBytes(4).toString("hex").toUpperCase();
  const r = (await rows<any>("fifo", `
    INSERT INTO fifo_cases (case_ref, subject, merchant_id, order_ref, severity, opened_by)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING id::text, case_ref
  `, [ref, input.subject, input.merchantId ?? null, input.orderRef ?? null, input.severity ?? "MEDIUM", input.openedBy ?? null]))[0];
  await addNote({ caseId: r.id, kind: "ACTION", body: "case opened", author: input.openedBy });
  return r;
}

export async function addNote(input: {
  caseId: string; kind?: string; body?: string; evidenceRef?: string; author?: string;
}): Promise<void> {
  await rows("fifo", `
    INSERT INTO fifo_case_notes (case_id, kind, body, evidence_ref, author)
    VALUES ($1::uuid,$2,$3,$4,$5)
  `, [input.caseId, input.kind ?? "NOTE", input.body ?? null, input.evidenceRef ?? null, input.author ?? null]).catch(() => {});
}

// Place the case's linked order on HOLD (§23 "place transaction on hold").
export async function placeCaseHold(caseId: string, actor: string): Promise<{ ok: boolean; error?: string }> {
  const c = (await rows<any>("fifo", `SELECT order_ref FROM fifo_cases WHERE id=$1::uuid`, [caseId]))[0];
  if (!c?.order_ref) return { ok: false, error: "case has no linked order" };
  const o = (await rows<any>("fifo", `SELECT id::text, status FROM fifo_orders WHERE order_ref=$1`, [c.order_ref]))[0];
  if (!o) return { ok: false, error: "order not found" };
  const r = await transition({ orderId: o.id, to: "HOLD", actor, actorKind: "admin", reason: `compliance hold (case)` });
  if (!r.ok) return { ok: false, error: r.error };
  await addNote({ caseId, kind: "ACTION", body: `placed ${c.order_ref} on HOLD`, author: actor });
  return { ok: true };
}

export async function closeCase(caseId: string, actor: string): Promise<void> {
  await rows("fifo", `UPDATE fifo_cases SET status='CLOSED', closed_at=now() WHERE id=$1::uuid`, [caseId]).catch(() => {});
  await addNote({ caseId, kind: "ACTION", body: "case closed", author: actor });
}
