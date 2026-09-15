// The dashboard's TEST / LIVE switch — which data a signed-in user is looking at, and which mode
// the orders they create from the dashboard use.
//
// Stored in its own cookie, read on the server. It is deliberately NOT part of the session:
// switching must not re-sign the session, and it carries no authority. Two rules follow:
//   - API orders never read it. Their mode comes from the key they are signed with
//     (lib/merchant-checkout.ts), so a dashboard setting can never turn a test key live.
//   - Money never reads it. Settlement, ledger, statements and reconciliation only ever count
//     live orders, whatever this says.
//
// No cookie, or any value other than "test", means live — so nothing changes for anyone
// until they deliberately switch to test.

import { cookies } from "next/headers";

export const MODE_COOKIE = "katana_mode";

/** true = live (the default), false = the user switched the dashboard to test. */
export async function getLivemode(): Promise<boolean> {
  const jar = await cookies();
  return jar.get(MODE_COOKIE)?.value !== "test";
}
