// Capture what the gateway told us about a payment, so it can be shown back to the
// merchant the way the gateway's own dashboard shows it.
//
// Every channel that learns something about a payment calls this: the webhook and the
// browser return (full callback payload) and the verify sweep (a thinner reply). They
// arrive in any order and none is guaranteed, so the upsert is additive — a later,
// poorer update can enrich a field but can never blank one that is already known.
//
// `raw` is keyed by source, so the webhook payload and the verify reply are both kept
// intact rather than overwriting each other. When a gateway adds a field we did not
// anticipate, it is still there to read.

import { rows } from "@/lib/pg";

export type DetailSource = "webhook" | "return" | "verify_api";

/** Amounts arrive as strings, sometimes empty, sometimes absent. "" and junk → null. */
function num(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? String(n) : null;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" || s === "--" ? null : s;
}

/** PayU stamps `addedon` as "YYYY-MM-DD HH:MM:SS" in IST, with no zone marker. */
function ts(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s.includes("T") ? s : s.replace(" ", "T") + "+05:30");
  return Number.isNaN(+d) ? null : d.toISOString();
}

/**
 * A UPI handle looks like `name@bank`. PayU does not always send `vpa`; for UPI it
 * often lands in one of the field* slots. Only accept something that actually looks
 * like a handle — guessing wrong here would show one customer's VPA on another's
 * payment, which is worse than showing nothing.
 */
function vpaOf(p: Record<string, any>): string | null {
  const direct = str(p.vpa) ?? str(p.payer_vpa) ?? str(p.upi_va);
  if (direct) return direct;
  const mode = String(p.mode ?? "").toUpperCase();
  if (mode !== "UPI") return null;
  for (const k of ["field1", "field2", "field3"]) {
    const v = str(p[k]);
    if (v && /^[\w.\-]{2,}@[a-z]{2,}$/i.test(v)) return v;
  }
  return null;
}

function udfOf(p: Record<string, any>): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (let i = 1; i <= 10; i++) { const v = str(p[`udf${i}`]); if (v) out[`udf${i}`] = v; }
  for (let i = 0; i <= 9; i++) { const v = str(p[`field${i}`]); if (v) out[`field${i}`] = v; }
  return Object.keys(out).length ? out : null;
}

export interface CaptureInput {
  orderId: string;
  provider: string;
  source: DetailSource;
  hashVerified?: boolean;
  /** The gateway payload exactly as received. */
  payload: Record<string, any>;
}

/**
 * Persist the gateway's account of a payment. Never throws — losing the detail record
 * must not cost us the payment confirmation itself, which is the part that matters.
 */
export async function capturePaymentDetails(input: CaptureInput): Promise<void> {
  const p = input.payload ?? {};

  // PayU splits the acquirer reference across two names depending on the rail, and the
  // verify API uses snake_case where the callback uses camelCase. Accept either.
  const bankRef = str(p.bank_ref_num) ?? str(p.bankRefNum) ?? str(p.bank_ref_no);
  const errMsg  = str(p.error_Message) ?? str(p.error_message) ?? str(p.error);
  const errCode = str(p.error_code) ?? str(p.errorCode);

  await rows("checkout", `
    INSERT INTO payment_details (
      order_id, provider, provider_payment_id, bank_ref_num, payment_type, bank_name,
      card_masked, card_network, name_on_card, vpa,
      amount, net_amount_debit, discount,
      customer_name, customer_email, customer_phone,
      gateway_status, error_code, error_message, udf, raw,
      source, hash_verified, captured_at, updated_at
    ) VALUES (
      $1::uuid, $2, $3, $4, $5, $6,
      $7, $8, $9, $10,
      $11::numeric, $12::numeric, $13::numeric,
      $14, $15, $16,
      $17, $18, $19, $20::jsonb, jsonb_build_object($21::text, $22::jsonb),
      $21, $23, $24::timestamptz, now()
    )
    ON CONFLICT (order_id) DO UPDATE SET
      provider_payment_id = COALESCE(EXCLUDED.provider_payment_id, payment_details.provider_payment_id),
      bank_ref_num        = COALESCE(EXCLUDED.bank_ref_num,        payment_details.bank_ref_num),
      payment_type        = COALESCE(EXCLUDED.payment_type,        payment_details.payment_type),
      bank_name           = COALESCE(EXCLUDED.bank_name,           payment_details.bank_name),
      card_masked         = COALESCE(EXCLUDED.card_masked,         payment_details.card_masked),
      card_network        = COALESCE(EXCLUDED.card_network,        payment_details.card_network),
      name_on_card        = COALESCE(EXCLUDED.name_on_card,        payment_details.name_on_card),
      vpa                 = COALESCE(EXCLUDED.vpa,                 payment_details.vpa),
      amount              = COALESCE(EXCLUDED.amount,              payment_details.amount),
      net_amount_debit    = COALESCE(EXCLUDED.net_amount_debit,    payment_details.net_amount_debit),
      discount            = COALESCE(EXCLUDED.discount,            payment_details.discount),
      customer_name       = COALESCE(EXCLUDED.customer_name,       payment_details.customer_name),
      customer_email      = COALESCE(EXCLUDED.customer_email,      payment_details.customer_email),
      customer_phone      = COALESCE(EXCLUDED.customer_phone,      payment_details.customer_phone),
      gateway_status      = COALESCE(EXCLUDED.gateway_status,      payment_details.gateway_status),
      error_code          = COALESCE(EXCLUDED.error_code,          payment_details.error_code),
      error_message       = COALESCE(EXCLUDED.error_message,       payment_details.error_message),
      udf                 = COALESCE(EXCLUDED.udf,                 payment_details.udf),
      captured_at         = COALESCE(EXCLUDED.captured_at,         payment_details.captured_at),
      -- A hash that verified once stays verified; a later unsigned channel (the verify
      -- API carries no reverse hash) must not downgrade it.
      hash_verified       = COALESCE(payment_details.hash_verified, EXCLUDED.hash_verified),
      -- Keep every channel's payload side by side instead of overwriting.
      raw                 = payment_details.raw || EXCLUDED.raw,
      source              = EXCLUDED.source,
      updated_at          = now()
  `, [
    input.orderId, input.provider,
    str(p.mihpayid) ?? str(p.provider_payment_id), bankRef,
    str(p.mode) ?? str(p.payment_type), str(p.bankcode) ?? str(p.issuing_bank) ?? str(p.bank_name),
    str(p.cardnum) ?? str(p.card_masked), str(p.card_type) ?? str(p.card_network),
    str(p.name_on_card), vpaOf(p),
    num(p.amount) ?? num(p.amt), num(p.net_amount_debit), num(p.discount),
    [str(p.firstname), str(p.lastname)].filter(Boolean).join(" ") || null,
    str(p.email), str(p.phone),
    str(p.status), errCode, errMsg,
    udfOf(p) ? JSON.stringify(udfOf(p)) : null,
    input.source, JSON.stringify(p),
    input.hashVerified ?? null, ts(p.addedon),
  ]).catch(() => {});
}
