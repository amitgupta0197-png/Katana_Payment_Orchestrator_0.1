// KYB identifier checks (lib/kyc-validators): format and check character, no registry.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  gstinProblem, gstinCheckChar, gstinPan, panProblem, panHolderType, ifscProblem,
  aadhaarLast4Problem, mccProblem, mccStanding, prohibitedWords, tidyId,
} from "@/lib/kyc-validators";

// A well-formed GSTIN built from a PAN, with the check character worked out.
const gstinFor = (state: string, pan: string, entity = "1") => {
  const first14 = `${state}${pan}${entity}Z`;
  return first14 + gstinCheckChar(first14);
};

test("the GSTIN check character matches published examples", () => {
  assert.equal(gstinProblem("27AAPFU0939F1ZV"), null);
  assert.equal(gstinProblem("29AAGCB7383J1Z4"), null);
});

test("a GSTIN with one wrong character fails its check character", () => {
  assert.match(gstinProblem("27AAPFU0939F1ZW")!, /check character/);
  assert.match(gstinProblem("27AAPFU0938F1ZV")!, /check character/);
});

test("a GSTIN is refused for its length, shape or state code", () => {
  assert.match(gstinProblem("27AAPFU0939F1Z")!, /15 characters/);
  assert.match(gstinProblem("2700PFU0939F1ZV")!, /shape/);
  assert.match(gstinProblem(gstinFor("00", "AAPFU0939F"))!, /state code/);
  assert.equal(gstinProblem(gstinFor("07", "AAACR5055K")), null);
});

test("identifiers are read as typed: lower case, spaces and dashes", () => {
  assert.equal(tidyId(" 27aapfu-0939f 1zv "), "27AAPFU0939F1ZV");
  assert.equal(gstinProblem("27aapfu0939f1zv"), null);
});

test("the PAN inside a GSTIN is characters 3 to 12", () => {
  assert.equal(gstinPan("27AAPFU0939F1ZV"), "AAPFU0939F");
});

test("a PAN is checked for shape, and its 4th character says who holds it", () => {
  assert.equal(panProblem("AAPFU0939F"), null);
  assert.match(panProblem("AAPFU0939")!, /10 characters/);
  assert.match(panProblem("AAPXU0939F")!, /shape/);       // X is not a holder type
  assert.match(panProblem("AAPFU09E9F")!, /shape/);
  assert.equal(panHolderType("AAPFU0939F"), "FIRM");
  assert.equal(panHolderType("ABCPK1234L"), "INDIVIDUAL");
  assert.equal(panHolderType("AAACR5055K"), "COMPANY");
});

test("an IFSC is four letters, a zero and six characters", () => {
  assert.equal(ifscProblem("HDFC0001234"), null);
  assert.equal(ifscProblem("sbin0abc123"), null);
  assert.match(ifscProblem("HDFC1001234")!, /shape/);     // the 5th character must be 0
  assert.match(ifscProblem("HDFC000123")!, /11 characters/);
});

test("only the last four digits of an Aadhaar are taken", () => {
  assert.equal(aadhaarLast4Problem("1234"), null);
  assert.ok(aadhaarLast4Problem("123456789012"));
  assert.ok(aadhaarLast4Problem("12a4"));
});

test("a category code is four digits, and some categories are prohibited or need review", () => {
  assert.equal(mccProblem("5411"), null);
  assert.ok(mccProblem("541"));
  assert.deepEqual(mccStanding("5411"), { standing: "OK" });
  assert.equal(mccStanding("7995").standing, "PROHIBITED");
  assert.equal(mccStanding("6051").standing, "REVIEW");
  assert.equal(mccStanding(null).standing, "OK");
});

test("prohibited-business words on a page are found once each, whatever their case", () => {
  assert.deepEqual(prohibitedWords("<h1>Online CASINO</h1> best casino and Betting tips"), ["casino", "betting"]);
  assert.deepEqual(prohibitedWords("Fresh groceries delivered. Vapour-free kitchen."), []);
});
