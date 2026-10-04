// The per-flow callback URL a sender should use (merchant 0019, banker_callback_urls).
// Imports only lib/pg and the pure rules, so the callback senders (lib/merchant-callback,
// lib/payout-api) can import it without pulling in anything else.
//
// Any failure here (the table not there yet, a database hiccup) answers null, and the sender
// goes on exactly as it did before per-flow URLs existed.

import { rows } from "@/lib/pg";
import { usableFlowUrl, type CallbackFlow } from "@/lib/integration";

export async function flowCallbackUrl(merchantCode: string | null | undefined, flow: CallbackFlow | null): Promise<string | null> {
  if (!merchantCode || !flow) return null;
  const r = await rows<{ url: string | null; status: string }>("merchant", `
    SELECT b.url, b.status FROM banker_callback_urls b JOIN merchants m ON m.id = b.merchant_id
     WHERE m.merchant_code = $1 AND b.flow = $2`, [merchantCode, flow]).catch(() => []);
  return usableFlowUrl(r[0]);
}
