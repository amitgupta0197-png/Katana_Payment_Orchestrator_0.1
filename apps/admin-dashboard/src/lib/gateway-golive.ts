// The gateway go-live checklist (vendorGateway 0038).
//
// A banker's gateway account does not become LIVE because live credentials were typed in. It
// becomes LIVE when the whole round trip has been seen to work on that account:
//
//   1. PING      Katana's callback URL for the gateway answers HTTP 200 to a test request
//   2. WEBHOOK   a real payment on the account was reported by the gateway's own webhook
//   3. STATUS    the gateway's status API says the same payment was paid
//   4. RECORD    each of those is kept with its time and the member of staff who ran it, and a
//                named member of staff then sets the account LIVE
//
// Step 2 needs real payments before the account is live, so an account that is VERIFYING takes
// a few small ones and nothing else: at most GOLIVE_VERIFY_MAX_ORDERS live orders of at most
// GOLIVE_VERIFY_MAX_AMOUNT rupees each. Anything else is refused (ACCOUNT_NOT_LIVE).
//
// AN ACCOUNT WITH NO ROW IS NOT GATED. That is every account that was taking live payments
// before this existed. A row is made only when live credentials are saved from here on
// (startVerifying), and an account that was already live and has its credentials rotated is
// recorded as LIVE, not sent back to the start.
//
// PER ACCOUNT (vendorGateway 0041). A banker can hold more than one account on the same gateway
// (the MID switch, lib/mid-switch), so a row is (banker, gateway, account), where `account` is the
// account's credential-vault label: 'gateway_mid' for the first, 'gateway_mid:<id>' for others.
// An order belongs to the account it was created on (meta.mid.vault_label, lib/gateway-creds
// orderVaultLabel); orders from before, and checkout orders, belong to the first account.
//
// STAFF ONLY. Everything here names gateways; the refusal a merchant sees does not.

import { rows } from "@/lib/pg";
import { getGatewayMid, payuKeySalt, VAULT_LABEL } from "@/lib/gateway-creds";
import { payinConnectorFor } from "@/lib/payin-providers";
import { payinWebhookUrl } from "@/lib/payin-providers/types";
import { verifyPayuTxn } from "@/lib/payu-verify";
import { gatewayAccountChannel, gatewayDef } from "@/lib/pg-catalog";

export type GoLiveStatus = "VERIFYING" | "LIVE";

export interface GoLiveRow {
  merchant_id: string; gateway: string; account: string; status: GoLiveStatus;
  ping_ok: boolean | null; ping_http_status: number | null; ping_at: string | null; ping_by: string | null;
  webhook_order_id: string | null; webhook_txn_id: string | null; webhook_at: string | null; webhook_by: string | null;
  status_order_id: string | null; status_at: string | null; status_by: string | null;
  live_at: string | null; live_by: string | null; note: string | null;
  created_at: string; created_by: string | null;
}

const COLS = `merchant_id, gateway, account, status, ping_ok, ping_http_status, ping_at, ping_by,
  webhook_order_id::text, webhook_txn_id, webhook_at, webhook_by,
  status_order_id::text, status_at, status_by, live_at, live_by, note, created_at, created_by`;

export const VERIFY_MAX_AMOUNT = Number(process.env.GOLIVE_VERIFY_MAX_AMOUNT ?? 100);
export const VERIFY_MAX_ORDERS = Number(process.env.GOLIVE_VERIFY_MAX_ORDERS ?? 20);

// ── The rules (pure) ─────────────────────────────────────────────────────────────

export interface ChecklistItem { key: "PING" | "WEBHOOK" | "STATUS" | "RECORD"; label: string; done: boolean; at: string | null; by: string | null; detail: string | null }

/** PayU with a Client ID + Secret is confirmed from its Payment Links API and sends no webhook. */
export function gatewaySendsWebhooks(gateway: string, auth?: string | null): boolean {
  // RubyVault's callbacks carry no order reference Katana can match yet (every one so far was
  // IGNORED), so a paid live order confirmed by its status API stands in, as for PayU Client ID.
  if (gateway === "RUBYVAULT") return false;
  return !(gateway === "PAYU" && auth === "client_credentials");
}

export function goLiveChecklist(r: GoLiveRow, sendsWebhooks = true): ChecklistItem[] {
  const ping = r.ping_ok === true;
  const webhook = !!r.webhook_at;
  const status = !!r.status_at && (!sendsWebhooks || r.status_order_id === r.webhook_order_id || !r.webhook_order_id);
  return [
    { key: "PING", label: "Callback URL is set and answers HTTP 200", done: ping, at: r.ping_at, by: r.ping_by,
      detail: r.ping_at ? `HTTP ${r.ping_http_status ?? "no answer"}` : null },
    { key: "WEBHOOK", label: sendsWebhooks ? "A real payment was confirmed by the gateway's webhook" : "A real payment was confirmed (this gateway sends no webhook)",
      done: webhook, at: r.webhook_at, by: r.webhook_by, detail: r.webhook_txn_id },
    { key: "STATUS", label: "A status check confirmed the same payment as paid", done: status, at: r.status_at, by: r.status_by,
      detail: r.status_at ? r.webhook_txn_id : null },
    { key: "RECORD", label: "Results recorded with time and staff name", done: ping && webhook && status && !!r.ping_by && !!r.webhook_by && !!r.status_by,
      at: r.live_at, by: r.live_by, detail: null },
  ];
}

export function canGoLive(r: GoLiveRow, sendsWebhooks = true): boolean {
  return goLiveChecklist(r, sendsWebhooks).every((i) => i.done);
}

/**
 * The largest payment a VERIFYING account of this gateway takes: GOLIVE_VERIFY_MAX_AMOUNT, raised to
 * the gateway's own live minimum when that is higher (RubyVault refuses live payments under ₹500,
 * so a ₹100 cap left no payment both would accept and the checklist could never finish).
 */
export function verifyMaxAmountFor(gateway: string | null | undefined): number {
  return Math.max(VERIFY_MAX_AMOUNT, (gateway && gatewayDef(gateway)?.payin.minAmount) || 0);
}

/** Why a VERIFYING account cannot take this live order, or null. */
export function verifyingBlocker(amount: number, ordersSoFar: number, maxAmount = VERIFY_MAX_AMOUNT, maxOrders = VERIFY_MAX_ORDERS): string | null {
  if (amount > maxAmount) return `only verification payments of up to ₹${maxAmount} are accepted until the account is live`;
  if (ordersSoFar >= maxOrders) return `the ${maxOrders} verification payments for this account have been used`;
  return null;
}

/** A live order refused because the banker's gateway account is still being verified. */
export class AccountNotLiveError extends Error {
  readonly status = 409;
  readonly code = "ACCOUNT_NOT_LIVE";
  constructor(reason: string) { super(`live payments on this account are still being verified: ${reason}`); }
}

// ── Store ────────────────────────────────────────────────────────────────────────

const missing = (err: unknown) => ["42P01", "42703"].includes((err as { code?: string }).code ?? "");

/** SQL: the account label of `vendor_payin_orders` row `o` (orders from before the switch are on the first account). */
export const ORDER_ACCOUNT_SQL = (o: string) => `COALESCE(${o}meta->'mid'->>'vault_label', '${VAULT_LABEL}')`;

export async function getGoLive(merchantCode: string, gateway: string, account: string = VAULT_LABEL): Promise<GoLiveRow | null> {
  return (await rows<GoLiveRow>("vendorGateway",
    `SELECT ${COLS} FROM gateway_golive WHERE merchant_id = $1 AND gateway = $2 AND account = $3`, [merchantCode, gateway, account]))[0] ?? null;
}

export async function listGoLive(): Promise<GoLiveRow[]> {
  return rows<GoLiveRow>("vendorGateway",
    `SELECT ${COLS} FROM gateway_golive ORDER BY (status = 'VERIFYING') DESC, created_at DESC LIMIT 500`);
}

/**
 * Live credentials were saved for this banker. A new live account starts VERIFYING; one that
 * was already live on the same gateway (`alreadyLive`) is recorded as LIVE.
 */
export async function startVerifying(merchantCode: string, gateway: string, by: string, alreadyLive: boolean, account: string = VAULT_LABEL): Promise<GoLiveRow | null> {
  await rows("vendorGateway", `
    INSERT INTO gateway_golive (merchant_id, gateway, account, status, created_by, live_at, live_by, note)
    VALUES ($1, $2, $6, $3, $4, CASE WHEN $3 = 'LIVE' THEN now() END, CASE WHEN $3 = 'LIVE' THEN $4 END, $5)
    ON CONFLICT (merchant_id, gateway, account) DO NOTHING
  `, [merchantCode, gateway, alreadyLive ? "LIVE" : "VERIFYING", by,
      alreadyLive ? "taking live payments before the go-live checklist existed" : null, account]);
  return getGoLive(merchantCode, gateway, account);
}

/**
 * Refuse a live order the account may not take yet. No row, a LIVE row, or a database without
 * the table: nothing is refused.
 */
export async function assertGoLiveAllows(merchantCode: string, gateway: string, amount: number, account: string = VAULT_LABEL): Promise<void> {
  let row: GoLiveRow | null;
  try { row = await getGoLive(merchantCode, gateway, account); }
  catch (err) { if (missing(err)) return; throw err; }
  if (!row || row.status === "LIVE") return;
  const blocker = verifyingBlocker(amount, await verificationOrdersUsed(row), verifyMaxAmountFor(gateway));
  if (blocker) throw new AccountNotLiveError(blocker);
}

/** Live orders a VERIFYING account has taken since it started verifying (they count against VERIFY_MAX_ORDERS). */
export async function verificationOrdersUsed(row: Pick<GoLiveRow, "merchant_id" | "gateway" | "account" | "created_at">): Promise<number> {
  const account = row.account ?? VAULT_LABEL;
  const [payins, checkouts] = await Promise.all([
    rows<{ n: number }>("vendorGateway", `
      SELECT COUNT(*)::int AS n FROM vendor_payin_orders
       WHERE vendor = 'KATANA' AND merchant_id = $1 AND livemode AND meta->'gateway'->>'provider' = $2 AND created_at >= $3
         AND ${ORDER_ACCOUNT_SQL("")} = $4`,
      [row.merchant_id, row.gateway, row.created_at, account]),
    // Checkout orders (/api/pay) are always made on the first account.
    account !== VAULT_LABEL ? Promise.resolve([{ n: 0 }]) : rows<{ n: number }>("checkout", `
      SELECT COUNT(*)::int AS n FROM checkout_orders WHERE merchant_id = $1 AND COALESCE(livemode, true) AND created_at >= $2`,
      [row.merchant_id, row.created_at]).catch(() => [{ n: 0 }]),
  ]);
  return (payins[0]?.n ?? 0) + (checkouts[0]?.n ?? 0);
}

/** As assertGoLiveAllows, for callers that answer with a message instead of throwing. */
export async function goLiveBlocker(merchantCode: string, gateway: string, amount: number, account: string = VAULT_LABEL): Promise<string | null> {
  try { await assertGoLiveAllows(merchantCode, gateway, amount, account); return null; }
  catch (err) { if (err instanceof AccountNotLiveError) return err.message; throw err; }
}

/** One account as the checklist screens show it (staff: it names the gateway). */
export async function goLiveView(r: GoLiveRow) {
  const mid = await getGatewayMid(r.merchant_id, r.account).catch(() => null);
  const hooks = gatewaySendsWebhooks(r.gateway, mid?.gateway === r.gateway ? mid.auth : null);
  return {
    ...r, account_label: r.account === VAULT_LABEL ? "First account" : `Account ${r.account.slice(VAULT_LABEL.length + 1, VAULT_LABEL.length + 9)}`,
    mid_code: mid?.mid_code ?? null, sends_webhooks: hooks, callback_url: hooks ? payinWebhookUrl(r.gateway) : null,
    credentials_match: mid?.gateway === r.gateway && mid.env === "PROD",
    // The flow the account runs on (a PayAtom account may be P2P), for the banker page's two tabs.
    channel: gatewayAccountChannel(mid),
    // This account's verification limits: the gateway's minimum, and the cap that allows it.
    verify_max_amount: verifyMaxAmountFor(r.gateway),
    min_amount: gatewayDef(r.gateway)?.payin.minAmount ?? null,
    checklist: goLiveChecklist(r, hooks), can_go_live: r.status === "VERIFYING" && canGoLive(r, hooks),
  };
}

// ── The three checks ─────────────────────────────────────────────────────────────

/** 1. Ask Katana's own callback URL for this gateway the way a gateway's "test" button does. */
export async function recordPing(merchantCode: string, gateway: string, by: string, account: string = VAULT_LABEL): Promise<GoLiveRow | null> {
  let http: number | null = null;
  try {
    const r = await fetch(payinWebhookUrl(gateway), { method: "GET", signal: AbortSignal.timeout(8_000), redirect: "manual" });
    http = r.status;
  } catch { /* recorded as no answer */ }
  await rows("vendorGateway", `
    UPDATE gateway_golive SET ping_ok = $3, ping_http_status = $4, ping_at = now(), ping_by = $5, updated_at = now()
     WHERE merchant_id = $1 AND gateway = $2 AND account = $6
  `, [merchantCode, gateway, http === 200, http, by, account]);
  return getGoLive(merchantCode, gateway, account);
}

/**
 * 2. Look for a real payment on this account that the gateway's webhook reported as paid, since
 * the account started verifying. For a gateway that sends no webhook, a paid live order.
 */
export async function recordWebhookPayment(merchantCode: string, gateway: string, by: string, sendsWebhooks = true, account: string = VAULT_LABEL): Promise<GoLiveRow | null> {
  const row = await getGoLive(merchantCode, gateway, account);
  if (!row) return null;
  const found = sendsWebhooks
    ? (await rows<{ order_id: string | null; txn_id: string | null; at: string }>("vendorGateway", `
        SELECT e.order_id::text, e.txn_id, e.received_at AS at FROM gateway_webhook_events e
          LEFT JOIN vendor_payin_orders o ON o.id = e.order_id   -- no order: counted for the first account
         WHERE e.merchant_id = $1 AND e.gateway = $2 AND e.received_at >= $3
           AND e.gateway_status = 'SUCCESS' AND e.outcome IN ('APPLIED','ALREADY_FINAL')
           AND e.signature_ok IS DISTINCT FROM false
           AND COALESCE(o.meta->'mid'->>'vault_label', '${VAULT_LABEL}') = $4      -- a payment on THIS account
         ORDER BY e.received_at ASC LIMIT 1`, [merchantCode, gateway, row.created_at, account]))[0]
    : (await rows<{ order_id: string | null; txn_id: string | null; at: string }>("vendorGateway", `
        SELECT id::text AS order_id, vendor_txn_id AS txn_id, updated_at AS at FROM vendor_payin_orders
         WHERE vendor = 'KATANA' AND merchant_id = $1 AND livemode AND status IN ('SUCCESS','SUCCEEDED')
           AND meta->'gateway'->>'provider' = $2 AND created_at >= $3 AND ${ORDER_ACCOUNT_SQL("")} = $4
         ORDER BY created_at ASC LIMIT 1`, [merchantCode, gateway, row.created_at, account]))[0];
  if (!found) return row;
  await rows("vendorGateway", `
    UPDATE gateway_golive SET webhook_order_id = $3::uuid, webhook_txn_id = $4, webhook_at = $5, webhook_by = $6, updated_at = now()
     WHERE merchant_id = $1 AND gateway = $2 AND account = $7
  `, [merchantCode, gateway, found.order_id, found.txn_id, found.at, by, account]);
  return getGoLive(merchantCode, gateway, account);
}

/** 3. Ask the gateway's status API about that same payment. Changes no order. */
export async function recordStatusCheck(merchantCode: string, gateway: string, by: string, account: string = VAULT_LABEL): Promise<{ row: GoLiveRow | null; answer: string }> {
  const row = await getGoLive(merchantCode, gateway, account);
  if (!row?.webhook_txn_id) return { row, answer: "no confirmed payment to check yet" };
  // Asked with this account's own credentials.
  const mid = await getGatewayMid(merchantCode, account);
  if (!mid || mid.gateway !== gateway) return { row, answer: "the saved credentials are for another gateway" };
  let paid = false, answer = "";
  const payu = payuKeySalt(mid);
  if (payu) {
    const v = await verifyPayuTxn(payu, row.webhook_txn_id);
    paid = v.found && v.status === "success"; answer = v.status;
  } else {
    const connector = payinConnectorFor(mid);
    if (!connector) return { row, answer: "no connector for this gateway" };
    // The gateway's own id for the payment, for a gateway that looks orders up by it (PayAtom).
    const ref = row.webhook_order_id ? (await rows<{ ref: string | null }>("vendorGateway",
      `SELECT meta->'gateway'->>'payment_id' AS ref FROM vendor_payin_orders WHERE id = $1::uuid`, [row.webhook_order_id]).catch(() => []))[0]?.ref ?? null : null;
    const s = await connector.status(mid, row.webhook_txn_id, undefined, ref);
    paid = s.ok && s.data.final === "SUCCESS";
    answer = s.ok ? s.data.status ?? (s.data.found ? "not final" : "not found") : s.error;
  }
  if (paid)
    await rows("vendorGateway", `
      UPDATE gateway_golive SET status_order_id = webhook_order_id, status_at = now(), status_by = $3, updated_at = now()
       WHERE merchant_id = $1 AND gateway = $2 AND account = $4
    `, [merchantCode, gateway, by, account]);
  return { row: await getGoLive(merchantCode, gateway, account), answer: paid ? "paid" : answer || "not paid" };
}

/** 4. Set the account LIVE. Refused until the checklist is complete. */
export async function setLive(merchantCode: string, gateway: string, by: string, note: string | null, sendsWebhooks = true, account: string = VAULT_LABEL): Promise<{ ok: true; row: GoLiveRow } | { ok: false; error: string }> {
  const row = await getGoLive(merchantCode, gateway, account);
  if (!row) return { ok: false, error: "no go-live record for this account" };
  if (row.status === "LIVE") return { ok: true, row };
  const open = goLiveChecklist(row, sendsWebhooks).filter((i) => !i.done && i.key !== "RECORD").map((i) => i.label);
  if (open.length) return { ok: false, error: `the checklist is not complete: ${open.join("; ")}` };
  const upd = await rows<GoLiveRow>("vendorGateway", `
    UPDATE gateway_golive SET status = 'LIVE', live_at = now(), live_by = $3, note = COALESCE($4, note), updated_at = now()
     WHERE merchant_id = $1 AND gateway = $2 AND account = $5 AND status = 'VERIFYING' RETURNING ${COLS}
  `, [merchantCode, gateway, by, note, account]);
  return upd.length ? { ok: true, row: upd[0] } : { ok: false, error: "the account changed while it was being set live; reload" };
}
