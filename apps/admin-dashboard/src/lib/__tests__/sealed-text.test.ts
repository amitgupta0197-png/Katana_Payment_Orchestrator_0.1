// Secrets sealed in a text column (lib/sealed-text).

import { test } from "node:test";
import assert from "node:assert/strict";
import { isSealed, openText, sealText } from "@/lib/sealed-text";

test("a sealed secret opens to what was sealed, and does not contain it", () => {
  const sealed = sealText("JBSWY3DPEHPK3PXP");
  assert.equal(isSealed(sealed), true);
  assert.equal(sealed.includes("JBSWY3DPEHPK3PXP"), false);
  assert.equal(openText(sealed), "JBSWY3DPEHPK3PXP");
});

test("the same secret sealed twice gives two different values", () => {
  assert.notEqual(sealText("same"), sealText("same"));
});

test("a value from before sealing existed is returned as it is", () => {
  assert.equal(isSealed("abcd efgh ijkl mnop"), false);
  assert.equal(openText("abcd efgh ijkl mnop"), "abcd efgh ijkl mnop");
  assert.equal(openText(null), null);
  assert.equal(openText(undefined), null);
});

test("a sealed value that has been altered does not open", () => {
  const sealed = sealText("secret");
  const i = sealed.length - 6;
  const altered = sealed.slice(0, i) + (sealed[i] === "A" ? "B" : "A") + sealed.slice(i + 1);
  assert.throws(() => openText(altered));
});
