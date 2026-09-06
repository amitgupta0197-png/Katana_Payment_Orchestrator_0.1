// Static QR operations & switching (QR BRD modules 01, 02, 05, 08 — phase 1).
//
// The one thing this file exists to make true: when a banker clicks "switch" on a store,
// that store's live payment endpoint moves to another of the banker's QRs exactly once,
// or not at all. Everything else here is in service of that.
//
// NAMING — the BRD's words are the UI's words, not the database's (middleware.ts:103-105):
//
//   BRD "Banker"   = persona MERCHANT = merchants.merchant_code  -> bankerCode (text)
//   BRD "Merchant" = persona PROVIDER = providers.id             -> providerId (uuid)
//   BRD "Store"    = merchant_store                              -> storeId   (uuid)
//
// A banker's session.scope_id IS its merchant_code, so `bankerCode` below is the value a
// MERCHANT-persona session already carries — no lookup needed to scope a banker to its own
// inventory.
//
// SCOPE OF THIS PHASE: same-banker switching only. A store moves between QRs owned by the
// banker already serving it. Cross-banker failover (BRD module 06's "NO -> check approved
// bankers" branch) is deliberately NOT implemented — see assertSameBanker below, which
// refuses it rather than silently allowing it.

import { db, rows } from "@/lib/pg";

export const QR_PROVIDERS = ["GOOGLE_PAY", "PHONEPE", "PAYTM", "MOBIKWIK", "BHARATPE", "OTHER"] as const;
export type QrProvider = (typeof QR_PROVIDERS)[number];

export const SETTLEMENT_TYPES = ["INSTANT", "T1", "MANUAL"] as const;
export type SettlementType = (typeof SETTLEMENT_TYPES)[number];

export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED";
export type RoutingStatus = "AVAILABLE" | "RESERVED" | "ALLOCATED" | "PAUSED";

/** Human labels for the provider enum, so one spelling serves every screen. */
export const PROVIDER_LABEL: Record<QrProvider, string> = {
  GOOGLE_PAY: "Google Pay",
  PHONEPE: "PhonePe",
  PAYTM: "Paytm",
  MOBIKWIK: "MobiKwik",
  BHARATPE: "BharatPe",
  OTHER: "Other",
};

export interface BankerQr {
  id: string;
  banker_code: string;
  provider: QrProvider;
  upi_id: string;
  qr_image_uri: string | null;
  settlement_type: SettlementType;
  daily_limit: number | null;
  remarks: string | null;
  approval_status: ApprovalStatus;
  routing_status: RoutingStatus;
  created_at: string;
}

/** A store as the switch screen needs it: who it belongs to and what it is live on now. */
export interface StoreWithEndpoint {
  store_id: string;
  store_code: string;
  store_name: string;
  city: string | null;
  provider_id: string;
  merchant_name: string;         // providers.legal_name — the UI's "Merchant"
  assignment_id: string | null;
  qr_id: string | null;
  qr_upi_id: string | null;
  qr_provider: QrProvider | null;
  banker_code: string | null;
  assigned_at: string | null;
}

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * Every store this banker currently serves — i.e. has the live endpoint on.
 *
 * Deliberately keyed off the ACTIVE assignment rather than off provider_merchant_mappings:
 * being an approved banker for a merchant is not the same as being the one currently
 * collecting for a given store, and the switch screen must show only the latter. A banker
 * cannot switch a store it is not on.
 */
export async function storesServedByBanker(bankerCode: string): Promise<StoreWithEndpoint[]> {
  return rows<StoreWithEndpoint>("provider", `
    SELECT s.id::text            AS store_id,
           s.code                AS store_code,
           s.name                AS store_name,
           s.city,
           s.provider_id::text   AS provider_id,
           p.legal_name          AS merchant_name,
           a.id::text            AS assignment_id,
           q.id::text            AS qr_id,
           q.upi_id              AS qr_upi_id,
           q.provider            AS qr_provider,
           a.banker_code,
           a.assigned_at
      FROM merchant_store_qr_assignment a
      JOIN merchant_store s ON s.id = a.store_id
      JOIN providers      p ON p.id = s.provider_id
      JOIN banker_qr      q ON q.id = a.qr_id
     WHERE a.is_active AND a.banker_code = $1
     ORDER BY p.legal_name, s.code
  `, [bankerCode]);
}

/** This banker's whole QR pool, newest first. */
export async function qrPoolForBanker(bankerCode: string): Promise<BankerQr[]> {
  return rows<BankerQr>("provider", `
    SELECT id::text, banker_code, provider, upi_id, qr_image_uri, settlement_type,
           daily_limit::float AS daily_limit, remarks, approval_status, routing_status,
           created_at
      FROM banker_qr
     WHERE banker_code = $1
     ORDER BY created_at DESC
  `, [bankerCode]);
}

/**
 * QRs this store could switch TO right now.
 *
 * Eligibility is the same set of filters BRD module 06 lists, minus the ones whose columns
 * arrive in phase 2 (payment_status, settlement health, incident state). Stated so the gap
 * is visible rather than assumed: today a QR is eligible if it is APPROVED, owned by the
 * banker already serving the store, not PAUSED, and not live on some other store.
 */
export async function switchCandidatesForStore(storeId: string): Promise<BankerQr[]> {
  return rows<BankerQr>("provider", `
    SELECT q.id::text, q.banker_code, q.provider, q.upi_id, q.qr_image_uri, q.settlement_type,
           q.daily_limit::float AS daily_limit, q.remarks, q.approval_status, q.routing_status,
           q.created_at
      FROM banker_qr q
     WHERE q.approval_status = 'APPROVED'
       AND q.routing_status <> 'PAUSED'
       -- same banker as the one currently serving this store (phase-1 scope)
       AND q.banker_code = (
             SELECT a.banker_code FROM merchant_store_qr_assignment a
              WHERE a.store_id = $1::uuid AND a.is_active LIMIT 1
           )
       -- not the endpoint it is already on, and not live on another store
       AND NOT EXISTS (
             SELECT 1 FROM merchant_store_qr_assignment a2
              WHERE a2.qr_id = q.id AND a2.is_active
           )
     ORDER BY q.created_at DESC
  `, [storeId]);
}

/**
 * This banker's QRs that are free to switch onto: approved, not paused, not live anywhere.
 *
 * The banker's switch screen shows one pool for all of its stores — every store it serves is
 * served by it, so the per-store candidate query collapses to this.
 */
export async function availableQrsForBanker(bankerCode: string): Promise<BankerQr[]> {
  return rows<BankerQr>("provider", `
    SELECT q.id::text, q.banker_code, q.provider, q.upi_id, q.qr_image_uri, q.settlement_type,
           q.daily_limit::float AS daily_limit, q.remarks, q.approval_status, q.routing_status,
           q.created_at
      FROM banker_qr q
     WHERE q.banker_code = $1
       AND q.approval_status = 'APPROVED'
       AND q.routing_status <> 'PAUSED'
       AND NOT EXISTS (
             SELECT 1 FROM merchant_store_qr_assignment a
              WHERE a.qr_id = q.id AND a.is_active
           )
     ORDER BY q.created_at DESC
  `, [bankerCode]);
}

/** Switch history for one store, newest first. */
export async function switchHistoryForStore(storeId: string, limit = 50) {
  return rows("provider", `
    SELECT e.id::text, e.from_qr_id::text, e.to_qr_id::text, e.banker_code, e.reason,
           e.actor, e.actor_role, e.created_at,
           fq.upi_id AS from_upi_id, tq.upi_id AS to_upi_id
      FROM qr_switch_events e
      LEFT JOIN banker_qr fq ON fq.id = e.from_qr_id
      JOIN      banker_qr tq ON tq.id = e.to_qr_id
     WHERE e.store_id = $1::uuid
     ORDER BY e.created_at DESC
     LIMIT $2
  `, [storeId, limit]);
}

// ── Adding a QR to the pool (BRD module 01) ──────────────────────────────────

/**
 * QR images are stored OUTSIDE the public web root and served through an authorised route,
 * exactly like provider KYC docs. A static QR is a bearer instrument for payments: anything
 * that can fetch the image can print it, so it must never sit under /public.
 */
const QR_IMAGE_STORE = process.env.QR_IMAGE_STORE ?? "/opt/katana/qr-store";
const QR_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
const QR_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/** Content must match its declared type — a renamed .exe is not a QR. */
function magicMatches(buf: Buffer, ct: string): boolean {
  if (buf.length < 12) return false;
  if (ct === "image/png") return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (ct === "image/jpeg") return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (ct === "image/webp")
    return buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP";
  return false;
}

export type QrImageError = { error: string; status: number };

/** Validate and persist a QR image. Returns its on-disk path and hash, or a typed refusal. */
export async function saveQrImage(
  file: File,
  bankerCode: string,
): Promise<{ uri: string; sha256: string } | QrImageError> {
  const { createHash, randomBytes } = await import("crypto");
  const { mkdir, writeFile } = await import("fs/promises");
  const path = (await import("path")).default;

  const ct = file.type || "application/octet-stream";
  if (!QR_IMAGE_TYPES.includes(ct))
    return { error: `content-type ${ct} not allowed (PNG/JPEG/WEBP only)`, status: 415 };
  if (file.size > QR_IMAGE_MAX_BYTES) return { error: "image too large (max 8MB)", status: 413 };

  const buf = Buffer.from(await file.arrayBuffer());
  if (!magicMatches(buf, ct))
    return { error: "file content does not match its type (failed scan)", status: 415 };

  const sha = createHash("sha256").update(buf).digest("hex");
  const ext = ct.split("/")[1] || "bin";
  const dir = path.join(QR_IMAGE_STORE, bankerCode);
  await mkdir(dir, { recursive: true });
  const uri = path.join(dir, `${sha.slice(0, 16)}_${randomBytes(4).toString("hex")}.${ext}`);
  await writeFile(uri, buf, { mode: 0o600 });
  return { uri, sha256: sha };
}

export interface CreateQrInput {
  bankerCode: string;
  provider: string;
  upiId: string;
  settlementType?: string | null;
  dailyLimit?: number | null;
  remarks?: string | null;
  imageUri?: string | null;
  imageSha?: string | null;
  createdBy: string;
  /** Admin-created rows are approved at birth; a banker's own upload waits for review. */
  autoApprove: boolean;
}

export type CreateQrResult =
  | { ok: true; id: string; approval_status: ApprovalStatus }
  | { ok: false; code: "DUPLICATE_UPI" | "BAD_PROVIDER" | "BAD_SETTLEMENT_TYPE"; message: string };

export async function createQr(input: CreateQrInput): Promise<CreateQrResult> {
  const provider = String(input.provider ?? "").toUpperCase();
  if (!(QR_PROVIDERS as readonly string[]).includes(provider))
    return { ok: false, code: "BAD_PROVIDER", message: `provider must be one of ${QR_PROVIDERS.join(", ")}` };

  const settlementType = String(input.settlementType ?? "INSTANT").toUpperCase();
  if (!(SETTLEMENT_TYPES as readonly string[]).includes(settlementType))
    return { ok: false, code: "BAD_SETTLEMENT_TYPE", message: `settlement_type must be one of ${SETTLEMENT_TYPES.join(", ")}` };

  // banker_qr_upi_live_uidx surfaces here as a friendly refusal rather than a 500. Two
  // bankers claiming one VPA is the failure this guards: money would land correctly and be
  // attributed to whichever row was read first.
  const ins = await rows<{ id: string; approval_status: ApprovalStatus }>("provider", `
    INSERT INTO banker_qr
      (banker_code, provider, upi_id, qr_image_uri, qr_image_sha256, settlement_type,
       daily_limit, remarks, approval_status, approved_by, approved_at, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
            $9, $10, CASE WHEN $9 = 'APPROVED' THEN now() END, $11)
    ON CONFLICT DO NOTHING
    RETURNING id::text, approval_status
  `, [
    input.bankerCode,
    provider,
    input.upiId.trim().toLowerCase(),
    input.imageUri ?? null,
    input.imageSha ?? null,
    settlementType,
    input.dailyLimit ?? null,
    input.remarks ?? null,
    input.autoApprove ? "APPROVED" : "PENDING",
    input.autoApprove ? input.createdBy : null,
    input.createdBy,
  ]);

  if (!ins.length)
    return { ok: false, code: "DUPLICATE_UPI", message: "that UPI ID is already registered on another QR" };

  await rows("provider", `
    INSERT INTO qr_audit_logs (qr_id, banker_code, action, actor, payload)
    VALUES ($1::uuid, $2, 'qr.created', $3, $4::jsonb)
  `, [ins[0].id, input.bankerCode, input.createdBy, JSON.stringify({
    provider, upi_id: input.upiId.trim().toLowerCase(),
    approval_status: ins[0].approval_status, auto_approved: input.autoApprove,
  })]);

  return { ok: true, id: ins[0].id, approval_status: ins[0].approval_status };
}

// ── The switch ───────────────────────────────────────────────────────────────

export type SwitchErrorCode =
  | "STORE_NOT_FOUND"
  | "STORE_INACTIVE"
  | "QR_NOT_FOUND"
  | "QR_NOT_APPROVED"
  | "QR_PAUSED"
  | "QR_IN_USE"
  | "SAME_QR"
  | "NOT_SERVING_STORE"
  | "CROSS_BANKER_NOT_ALLOWED";

export interface SwitchInput {
  storeId: string;
  toQrId: string;
  actor: string;
  actorRole: string;
  /**
   * When set, the caller may only act as this banker: the store's current endpoint and the
   * target QR must both belong to it. Banker-initiated switches always set this; an admin
   * doing a first allocation passes null.
   */
  bankerCode?: string | null;
  reason?: string | null;
  idempotencyKey?: string | null;
}

export type SwitchResult =
  | { ok: true; switch_id: string; from_qr_id: string | null; to_qr_id: string; replayed: boolean }
  | { ok: false; code: SwitchErrorCode; message: string };

/**
 * Move a store's live endpoint to another QR — atomically, once (BRD module 08).
 *
 * Everything happens inside one transaction with the target QR locked FOR UPDATE, because
 * the failure that matters is two people switching two stores onto the SAME free QR at the
 * same moment: both read it as available, both write, and one store silently ends up
 * collecting into an endpoint that another store also thinks it owns. The lock plus the
 * partial unique indexes (store_qr_one_active_uidx, store_qr_exclusive_uidx) make that
 * impossible rather than unlikely.
 *
 * Idempotent on `idempotencyKey`: a retried or double-submitted click returns the original
 * switch instead of performing a second one.
 */
export async function switchStoreQr(input: SwitchInput): Promise<SwitchResult> {
  const client = await db("provider").connect();
  try {
    await client.query("BEGIN");

    // Replay check first: a retry must cost nothing and change nothing.
    if (input.idempotencyKey) {
      const prior = await client.query(
        `SELECT id::text, from_qr_id::text AS from_qr_id, to_qr_id::text AS to_qr_id
           FROM qr_switch_events WHERE idempotency_key = $1`,
        [input.idempotencyKey],
      );
      if (prior.rows.length) {
        await client.query("ROLLBACK");
        const p = prior.rows[0];
        return { ok: true, switch_id: p.id, from_qr_id: p.from_qr_id, to_qr_id: p.to_qr_id, replayed: true };
      }
    }

    const fail = async (code: SwitchErrorCode, message: string): Promise<SwitchResult> => {
      await client.query("ROLLBACK");
      return { ok: false, code, message };
    };

    // Store must exist and be open for business.
    const st = await client.query(
      `SELECT id::text, provider_id::text AS provider_id, status, code, name
         FROM merchant_store WHERE id = $1::uuid`,
      [input.storeId],
    );
    if (!st.rows.length) return fail("STORE_NOT_FOUND", "store not found");
    if (st.rows[0].status !== "ACTIVE") return fail("STORE_INACTIVE", "store is not active");
    const store = st.rows[0];

    // Lock the target QR before validating it: validating an unlocked row is only a reading
    // of the past, and the whole point is that nobody else takes it between check and write.
    const tq = await client.query(
      `SELECT id::text, banker_code, approval_status, routing_status, upi_id
         FROM banker_qr WHERE id = $1::uuid FOR UPDATE`,
      [input.toQrId],
    );
    if (!tq.rows.length) return fail("QR_NOT_FOUND", "target QR not found");
    const target = tq.rows[0];
    if (target.approval_status !== "APPROVED")
      return fail("QR_NOT_APPROVED", `target QR is ${String(target.approval_status).toLowerCase()}, not approved`);
    if (target.routing_status === "PAUSED")
      return fail("QR_PAUSED", "target QR is paused");

    // Current live endpoint, locked too — it is about to be deactivated.
    const cur = await client.query(
      `SELECT id::text, qr_id::text AS qr_id, banker_code
         FROM merchant_store_qr_assignment
        WHERE store_id = $1::uuid AND is_active
        FOR UPDATE`,
      [input.storeId],
    );
    const current = cur.rows[0] ?? null;

    if (current && current.qr_id === input.toQrId)
      return fail("SAME_QR", "store is already on this QR");

    // Ownership rules. A banker may only move a store it is currently serving, and only onto
    // its own QR — both halves matter, and refusing loudly beats a silent cross-banker move.
    if (input.bankerCode) {
      if (!current) return fail("NOT_SERVING_STORE", "this store has no active endpoint to switch");
      if (current.banker_code !== input.bankerCode)
        return fail("NOT_SERVING_STORE", "this store is currently served by another banker");
      if (target.banker_code !== input.bankerCode)
        return fail("CROSS_BANKER_NOT_ALLOWED", "target QR belongs to another banker");
    } else if (current && current.banker_code !== target.banker_code) {
      // Admin path. Same-banker is still the phase-1 rule; cross-banker failover is BRD
      // module 06 and is not built yet, so refuse rather than half-do it.
      return fail(
        "CROSS_BANKER_NOT_ALLOWED",
        "cross-banker switching is not supported yet — target QR belongs to a different banker",
      );
    }

    // Swap. Deactivate then insert, so the partial unique index sees one active row
    // throughout; the index is what makes a concurrent duplicate fail rather than corrupt.
    const sw = await client.query(
      `INSERT INTO qr_switch_events
         (store_id, from_qr_id, to_qr_id, banker_code, reason, actor, actor_role, idempotency_key)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8)
       RETURNING id::text`,
      [
        input.storeId,
        current?.qr_id ?? null,
        input.toQrId,
        target.banker_code,
        input.reason ?? null,
        input.actor,
        input.actorRole,
        input.idempotencyKey ?? null,
      ],
    );
    const switchId = sw.rows[0].id;

    if (current) {
      await client.query(
        `UPDATE merchant_store_qr_assignment
            SET is_active = false, deactivated_by = $2, deactivated_at = now(), ended_by_switch = $3::uuid
          WHERE id = $1::uuid`,
        [current.id, input.actor, switchId],
      );
      // The QR it came off returns to the pool, ready to be switched back to.
      await client.query(
        `UPDATE banker_qr SET routing_status = 'AVAILABLE', updated_at = now()
          WHERE id = $1::uuid AND routing_status = 'ALLOCATED'`,
        [current.qr_id],
      );
    }

    await client.query(
      `INSERT INTO merchant_store_qr_assignment (store_id, qr_id, banker_code, assigned_by)
       VALUES ($1::uuid, $2::uuid, $3, $4)`,
      [input.storeId, input.toQrId, target.banker_code, input.actor],
    );
    await client.query(
      `UPDATE banker_qr SET routing_status = 'ALLOCATED', updated_at = now() WHERE id = $1::uuid`,
      [input.toQrId],
    );

    await client.query(
      `INSERT INTO provider_audit_logs (provider_id, actor, action, payload)
       VALUES ($1::uuid, $2, $3, $4::jsonb)`,
      [
        store.provider_id,
        input.actor,
        "store.qr.switched",
        JSON.stringify({
          switch_id: switchId,
          store_code: store.code,
          from_qr_id: current?.qr_id ?? null,
          to_qr_id: input.toQrId,
          to_upi_id: target.upi_id,
          banker_code: target.banker_code,
          actor_role: input.actorRole,
          reason: input.reason ?? null,
        }),
      ],
    );

    // Same switch, QR-centric trail — "what happened to this QR" has a different reader from
    // "what happened to my stores". Inside the transaction, so it cannot go missing.
    await client.query(
      `INSERT INTO qr_audit_logs (qr_id, banker_code, action, actor, actor_role, payload)
       VALUES ($1::uuid, $2, 'qr.switched_to', $3, $4, $5::jsonb)`,
      [
        input.toQrId,
        target.banker_code,
        input.actor,
        input.actorRole,
        JSON.stringify({ switch_id: switchId, store_code: store.code, from_qr_id: current?.qr_id ?? null }),
      ],
    );

    await client.query("COMMIT");
    return {
      ok: true,
      switch_id: switchId,
      from_qr_id: current?.qr_id ?? null,
      to_qr_id: input.toQrId,
      replayed: false,
    };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    // The exclusivity indexes are the last line of defence under concurrency. Losing that
    // race is an expected outcome, not a server fault, so it reads as a clean refusal.
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("store_qr_exclusive_uidx"))
      return { ok: false, code: "QR_IN_USE", message: "that QR was just taken by another store" };
    if (msg.includes("store_qr_one_active_uidx"))
      return { ok: false, code: "QR_IN_USE", message: "this store was switched by someone else a moment ago" };
    throw e;
  } finally {
    client.release();
  }
}

/** Map a switch refusal onto an HTTP status: caller error vs. lost race. */
export function switchHttpStatus(code: SwitchErrorCode): number {
  switch (code) {
    case "STORE_NOT_FOUND":
    case "QR_NOT_FOUND":
      return 404;
    case "QR_IN_USE":
      return 409;
    case "NOT_SERVING_STORE":
    case "CROSS_BANKER_NOT_ALLOWED":
      return 403;
    default:
      return 400;
  }
}
