// Who is made to set two-factor up.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mfaSetupRequired } from "../mfa-policy";

test("with enforcement off nobody is made to set two-factor up", () => {
  assert.equal(mfaSetupRequired({ persona: "SUPER_ADMIN" }, false), false);
});

test("with enforcement on, staff without a code are, and merchants are not", () => {
  for (const persona of ["SUPER_ADMIN", "ADMIN", "OPERATOR", "FINANCE", "RISK", "COMPLIANCE", "SUPPORT"] as const) {
    assert.equal(mfaSetupRequired({ persona }, true), true, persona);
    assert.equal(mfaSetupRequired({ persona, mfa: true }, true), false, persona);
  }
  for (const persona of ["PROVIDER", "MERCHANT", "BANKER"] as const)
    assert.equal(mfaSetupRequired({ persona }, true), false, persona);
});
