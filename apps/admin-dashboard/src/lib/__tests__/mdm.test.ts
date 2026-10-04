// Master Data Management rules (lib/mdm).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CORE, MASTERS, MASTER_TYPES, buildFormSchema, composeFields, coreLockProblem, customFieldProblem, defaultColumns,
  describeChange, parseMasterType, splitByApproval, templateProblem, validateExtra, valueProblem, type MdmField,
} from "@/lib/mdm";

const region: MdmField = { key: "region", label: "Region", type: "enum", required: false, options: ["NORTH", "SOUTH"] };
const ref: MdmField = { key: "agreement_ref", label: "Agreement ref", type: "string", required: false, regex: "[A-Z]{3}-[0-9]{4}", requires_approval: true };
const limit: MdmField = { key: "risk_score", label: "Risk score", type: "number", required: false, min: 0, max: 100 };

test("every master type has core fields, an id, its summary and search columns among them", () => {
  for (const t of MASTER_TYPES) {
    const keys = CORE[t].map((f) => f.key);
    assert.ok(keys.includes("id"), t);
    assert.equal(new Set(keys).size, keys.length, `${t} core keys unique`);
    for (const k of [...MASTERS[t].summary, ...MASTERS[t].search, MASTERS[t].title]) assert.ok(keys.includes(k), `${t}.${k}`);
    assert.ok(CORE[t].every((f) => f.core));
  }
  assert.equal(parseMasterType("banker"), "BANKER");
  assert.equal(parseMasterType("nope"), null);
});

test("custom field definitions: snake_case keys, enum options, bounds, optional only", () => {
  assert.equal(customFieldProblem(region), null);
  assert.match(customFieldProblem({ ...region, key: "Region" })!, /snake_case/);
  assert.match(customFieldProblem({ ...region, key: "x" })!, /snake_case/);
  assert.match(customFieldProblem({ ...region, options: [] })!, /at least one option/);
  assert.match(customFieldProblem({ ...region, options: ["A", "A"] })!, /different/);
  assert.match(customFieldProblem({ ...limit, min: 5, max: 1 })!, /min is greater/);
  assert.match(customFieldProblem({ ...ref, regex: "([" })!, /not a valid regular expression/);
  assert.match(customFieldProblem({ ...region, required: true })!, /optional/);
  assert.match(customFieldProblem({ ...region, type: "uuid" as any })!, /type must be/);
  assert.match(customFieldProblem({ ...region, key: "extra" })!, /reserved/);
});

test("the core lock: every core field kept exactly; nothing new may be core", () => {
  const base = composeFields("BANK", [region]);
  assert.equal(coreLockProblem("BANK", base), null);
  assert.match(coreLockProblem("BANK", base.filter((f) => f.key !== "name"))!, /cannot be removed/);
  assert.match(coreLockProblem("BANK", base.map((f) => f.key === "contact_email" ? { ...f, required: true } : f))!, /locked/);
  assert.match(coreLockProblem("BANK", base.map((f) => f.key === "name" ? { ...f, core: undefined } : f))!, /custom field/);
  assert.match(coreLockProblem("BANK", [...base, { ...region, key: "swift", core: true }])!, /not a column/);
});

test("template validation: clash with core, duplicates, removal and type change refused", () => {
  const v1 = composeFields("TSP", [region]);
  assert.equal(templateProblem("TSP", composeFields("TSP", [region, limit]), v1), null);
  assert.match(templateProblem("TSP", composeFields("TSP", [region, { ...limit, key: "notes" }]), v1)!, /core column/);
  assert.match(templateProblem("TSP", composeFields("TSP", [region, region]), v1)!, /twice/);
  assert.match(templateProblem("TSP", composeFields("TSP", [limit]), v1)!, /retire it instead/);
  assert.match(templateProblem("TSP", composeFields("TSP", [{ ...region, type: "string", options: undefined }]), v1)!, /type cannot change/);
  // Retiring is allowed, and keeps the field.
  assert.equal(templateProblem("TSP", composeFields("TSP", [{ ...region, retired: true }]), v1), null);
});

test("describeChange names adds, edits, retirements and restores", () => {
  const v1 = composeFields("BANK", [region, limit]);
  const v2 = composeFields("BANK", [{ ...region, retired: true }, { ...limit, label: "Score" }, ref]);
  assert.deepEqual(describeChange(v1, v2), ["retire region", "edit risk_score", "add agreement_ref (string)"]);
  assert.deepEqual(describeChange(v2, composeFields("BANK", [region, { ...limit, label: "Score" }, ref])), ["restore region"]);
  assert.deepEqual(describeChange(v1, v1), []);
});

test("values: types, enum options, regex, min / max, dates, URLs, emails", () => {
  assert.equal(valueProblem(region, "NORTH"), null);
  assert.match(valueProblem(region, "EAST")!, /one of/);
  assert.equal(valueProblem(ref, "ABC-1234"), null);
  assert.match(valueProblem(ref, "ABC-1234x")!, /format/);
  assert.match(valueProblem(limit, 101)!, /at most 100/);
  assert.match(valueProblem(limit, "5")!, /number/);
  assert.equal(valueProblem({ key: "since", label: "Since", type: "date", required: false }, "2026-02-28"), null);
  assert.match(valueProblem({ key: "since", label: "Since", type: "date", required: false }, "2026-02-30")!, /real date/);
  assert.match(valueProblem({ key: "site", label: "Site", type: "url", required: false }, "javascript:alert(1)")!, /http/);
  assert.match(valueProblem({ key: "ops", label: "Ops", type: "email", required: false }, "nope")!, /email/);
  assert.equal(valueProblem({ key: "ok", label: "OK", type: "boolean", required: false }, false), null);
});

test("validateExtra: unknown and core keys refused, blank clears, unchanged is no change, retired read-only", () => {
  const fields = composeFields("BANKER", [region, limit, { ...ref, retired: true }]);
  const cur = { region: "NORTH", agreement_ref: "ABC-0001" };
  const ok = validateExtra(fields, cur, { region: "SOUTH", risk_score: 40 });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.next, { region: "SOUTH", risk_score: 40, agreement_ref: "ABC-0001" });
  assert.deepEqual(ok.changes.map((c) => c.key), ["region", "risk_score"]);

  const bad = validateExtra(fields, cur, { foo: 1, legal_name: "X", risk_score: 400 });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.foo, /not a field/);
  assert.match(bad.errors.legal_name, /core field/);
  assert.match(bad.errors.risk_score, /at most/);

  const cleared = validateExtra(fields, cur, { region: "" });
  assert.deepEqual(cleared.next, { agreement_ref: "ABC-0001" });
  assert.deepEqual(cleared.changes, [{ key: "region", before: "NORTH", after: null }]);

  assert.equal(validateExtra(fields, cur, { region: "NORTH", agreement_ref: "ABC-0001" }).changes.length, 0);
  assert.match(validateExtra(fields, cur, { agreement_ref: "XYZ-0002" }).errors.agreement_ref, /retired/);
  assert.equal(validateExtra(fields, cur, [] as any).ok, false);
});

test("splitByApproval sends only fields marked requires_approval to Maker-Checker", () => {
  const fields = composeFields("BANK", [region, ref]);
  const v = validateExtra(fields, {}, { region: "NORTH", agreement_ref: "ABC-1234" });
  const s = splitByApproval(fields, v.changes);
  assert.deepEqual(s.direct.map((c) => c.key), ["region"]);
  assert.deepEqual(s.approval.map((c) => c.key), ["agreement_ref"]);
});

test("form schema: core read-only, custom editable, retired shown only with a value", () => {
  const fields = composeFields("CHANNEL", [region, { ...limit, retired: true }]);
  const preview = buildFormSchema(fields);
  assert.deepEqual(preview.map((s) => s.id), ["core", "custom", "retired"]);
  assert.ok(preview[0].fields.every((f) => f.readOnly));
  assert.equal(preview[1].fields[0].input, "select");
  const rec = buildFormSchema(fields, { core: { provider: "x" }, extra: { region: "NORTH" } });
  assert.deepEqual(rec.map((s) => s.id), ["core", "custom"]);
  assert.equal(rec[1].fields[0].value, "NORTH");
  assert.equal(rec[0].fields.find((f) => f.key === "provider")!.value, "x");
  const sensitive = buildFormSchema(composeFields("BANK", [])).find((s) => s.id === "core")!.fields.find((f) => f.key === "settlement_account")!;
  assert.equal(sensitive.sensitive, true);
});

test("default list columns: core summary then up to three active custom fields", () => {
  const four = [region, limit, { ...ref, retired: true }, { ...region, key: "zone" }, { ...region, key: "tier_band" }];
  assert.deepEqual(defaultColumns("TSP", composeFields("TSP", four)), [...MASTERS.TSP.summary, "region", "risk_score", "zone"]);
});
