// POST /api/v1/katana-pay/callback — the payment-status webhook URL we give to a payment
// gateway / provider. White-labelled twin of /api/vendors/poolpay/callback: a partner sees a
// Katana Pay URL next to /api/v1/katana-pay/order, never the internal vendor name.
//
// Same handler, same contract — HMAC-SHA256 over (sha256(sorted JSON) + "." + x-timestamp)
// in x-signature, ±5 min window, idempotent confirmation. Kept as a re-export so the two URLs
// can never drift apart. Public: allow-listed in middleware PUBLIC_API.

export const dynamic = "force-dynamic";

export { POST } from "@/app/api/vendors/poolpay/callback/route";
