// Merchant activation for the DT refill model (2026-07-31).
//
// A merchant must be activated before it can raise DT purchase / refill requests.
// Kept in lib rather than in a route file so both the merchant routes and the admin
// review route answer "is this merchant activated?" from one place — and so a Next.js
// route module keeps exporting only its handlers.

import { rows } from "@/lib/pg";

// The two channel models a merchant can operate under:
//   PURE_INTENT  — merchant gets provider access (the intent/collect flow already live)
//   DIRECT_QUASI — third-party direct QR, with the Katana agent app on the collection
//                  phone tracking the RRN
export const ACTIVATION_MODELS = ["PURE_INTENT", "DIRECT_QUASI"] as const;
export type ActivationModel = (typeof ACTIVATION_MODELS)[number];

export const ACTIVATION_MODEL_LABEL: Record<string, string> = {
  PURE_INTENT: "Pure intent — provider access",
  DIRECT_QUASI: "Direct quasi — third-party QR + Katana agent",
};

export interface Activation {
  id: string;
  merchant_id: string;
  model: ActivationModel;
  status: "REQUESTED" | "APPROVED" | "REJECTED" | "REVOKED";
  request_note: string;
  review_note: string;
  requested_by: string;
  requested_at: string;
  reviewed_by: string;
  reviewed_at: string | null;
}

/**
 * The activation that governs this merchant right now.
 *
 * Ordering matters: an APPROVED row wins over a pending one, which wins over any
 * historical rejection. A merchant that was rejected once and later approved must read
 * as activated, not as rejected — so this cannot simply take the newest row.
 */
export async function activationFor(merchantId: string): Promise<Activation | null> {
  const r = await rows<any>("provider", `
    SELECT id::text, merchant_id, model, status,
           COALESCE(request_note,'') AS request_note, COALESCE(review_note,'') AS review_note,
           COALESCE(requested_by,'') AS requested_by, requested_at,
           COALESCE(reviewed_by,'') AS reviewed_by, reviewed_at
      FROM merchant_dt_activations
     WHERE merchant_id = $1
     ORDER BY CASE status WHEN 'APPROVED' THEN 0 WHEN 'REQUESTED' THEN 1 ELSE 2 END,
              requested_at DESC
     LIMIT 1
  `, [merchantId]).catch(() => []);
  return r[0] ?? null;
}

/** True only when the merchant holds a live APPROVED activation. */
export async function isActivated(merchantId: string): Promise<boolean> {
  return (await activationFor(merchantId))?.status === "APPROVED";
}
