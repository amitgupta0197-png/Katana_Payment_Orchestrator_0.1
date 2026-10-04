// Master Data Management against a real database (merchant 0022, provider 0022, routingEngine
// 0005, lib/mdm-store), with its Maker-Checker approvals. Run with `pnpm test:integration`.
//
// IT WRITES ROWS, so it only runs against a local database. It adds a bank and a TSP, proposes
// and approves template versions for BANK and MERCHANT and sets custom values on its bank and on
// one existing merchant. Afterwards it removes them: the template versions and change-log rows it
// wrote are deleted under `SET LOCAL mdm.maintenance = 'on'`, the merchant's `extra` is put back.
// WORM audit rows stay (append-only by design).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { db, rows } from "@/lib/pg";
import {
  MdmError, getRecord, getTemplate, home, listRecords, listVersions, proposeVersion, setExtra,
} from "@/lib/mdm-store";
import { MC_ACTIONS } from "@/lib/maker-checker-actions";
import { PendingRequestError } from "@/lib/maker-checker";
import { ChainError } from "@/lib/chain-store";
import { CORE, MASTER_TYPES, customFields, type MdmField } from "@/lib/mdm";

const HOST = process.env.PG_HOST ?? "localhost";
const LOCAL = ["localhost", "127.0.0.1", "::1"].includes(HOST);
const opts = { skip: LOCAL ? false : `refusing to write to a non-local database (${HOST})` };
const N = String(Date.now()).slice(-7);
const maker = { id: "00000000-0000-4000-8000-0000000000a1", email: "itest-mdm-maker@example.com" };
const checker = { id: "00000000-0000-4000-8000-0000000000a2", email: "itest-mdm-checker@example.com" };
const requests: string[] = [];
let bankId = "", tspId = "", providerId = "", providerExtra: unknown = {};
const baseline: Record<string, number> = {};
const started = new Date();

const region: MdmField = { key: `itest_region_${N}`, label: "Region", type: "enum", required: false, options: ["NORTH", "SOUTH"] };
const ref: MdmField = { key: `itest_ref_${N}`, label: "Agreement ref", type: "string", required: false, regex: "[A-Z]{3}-[0-9]{4}", requires_approval: true };

async function decide(requestId: string, by = checker) {
  const r = (await rows<any>("provider", `SELECT request_id::text, resource_type, resource_id, action, payload FROM maker_checker_requests WHERE request_id = $1::uuid`, [requestId]))[0];
  await rows("provider", `UPDATE maker_checker_requests SET status = 'APPROVED', checker_email = $2 WHERE request_id = $1::uuid AND status = 'PENDING'`, [requestId, by.email]);
  try { return await MC_ACTIONS[r.action].apply(r, by); }
  catch (e) { await rows("provider", `UPDATE maker_checker_requests SET status = 'PENDING', checker_email = NULL WHERE request_id = $1::uuid`, [requestId]); throw e; }
}
const code = async (p: Promise<unknown>) => {
  try { await p; return "OK"; }
  catch (e) { return e instanceof MdmError || e instanceof ChainError ? e.code : e instanceof PendingRequestError ? "REQUEST_PENDING" : String(e); }
};

before(async () => {
  if (!LOCAL) return;
  for (const t of MASTER_TYPES) baseline[t] = (await getTemplate(t)).version;
  bankId = (await rows<{ id: string }>("merchant", `INSERT INTO banks (code, name, bank_type, created_by) VALUES ($1, 'Itest MDM Bank', 'PRIVATE', 'itest') RETURNING id::text`, [`IMB${N}`]))[0].id;
  tspId = (await rows<{ id: string }>("merchant", `INSERT INTO tsps (code, name, tsp_type, created_by) VALUES ($1, 'Itest MDM PayCo', 'PAYMENT_GATEWAY', 'itest') RETURNING id::text`, [`IMT${N}`]))[0].id;
  await rows("merchant", `INSERT INTO tsp_banks (tsp_id, bank_id, status, created_by) VALUES ($1::uuid, $2::uuid, 'CONFIRMED', 'itest')`, [tspId, bankId]);
  const p = await rows<{ id: string; extra: unknown }>("provider", `SELECT id::text, extra FROM providers ORDER BY created_at LIMIT 1`);
  providerId = p[0]?.id ?? ""; providerExtra = p[0]?.extra ?? {};
});

after(async () => {
  if (!LOCAL) return;
  if (providerId) await rows("provider", `UPDATE providers SET extra = $2::jsonb WHERE id = $1::uuid`, [providerId, JSON.stringify(providerExtra)]);
  await rows("merchant", `DELETE FROM tsp_banks WHERE tsp_id = $1::uuid`, [tspId]).catch(() => {});
  await rows("merchant", `DELETE FROM tsps WHERE id = $1::uuid`, [tspId]).catch(() => {});
  await rows("merchant", `DELETE FROM banks WHERE id = $1::uuid`, [bankId]).catch(() => {});
  const c = await db("merchant").connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL mdm.maintenance = 'on'");
    for (const t of MASTER_TYPES) {
      await c.query(`DELETE FROM mdm_template_versions WHERE type = $1 AND version > $2`, [t, baseline[t]]);
      await c.query(`UPDATE mdm_templates SET current_version = $2 WHERE type = $1`, [t, baseline[t]]);
    }
    await c.query(`DELETE FROM mdm_change_log WHERE at >= $1 AND (record_id = ANY($2::text[]) OR request_id = ANY($3::text[]) OR actor IN ($4, $5))`,
      [started, [bankId, providerId], requests, maker.email, checker.email]);
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  if (requests.length) await rows("provider", `DELETE FROM maker_checker_requests WHERE request_id = ANY($1::uuid[])`, [requests]);
  await db("merchant").end(); await db("provider").end(); await db("routingEngine").end(); await db("audit").end().catch(() => {});
});

test("version 1 of each template was seeded with exactly the code's core fields", opts, async () => {
  for (const t of MASTER_TYPES) {
    const v1 = await rows<{ fields: MdmField[] }>("merchant", `SELECT fields FROM mdm_template_versions WHERE type = $1 AND version = 1`, [t]);
    assert.deepEqual(v1[0].fields, CORE[t], `${t} v1 matches lib/mdm CORE`);
  }
});

test("a template change is a Maker-Checker request; the maker cannot approve it; approval makes a new version", opts, async () => {
  const p = await proposeVersion("BANK", [...customFields((await getTemplate("BANK")).fields), region, ref], maker, "itest");
  requests.push(p.request_id);
  assert.ok(p.changes.includes(`add ${region.key} (enum)`));
  assert.equal(await code(proposeVersion("BANK", [{ ...region, key: "status" }], maker)), "INVALID_TEMPLATE"); // checked before the queue
  assert.equal(await code(proposeVersion("BANK", [...customFields((await getTemplate("BANK")).fields), region], maker)), "REQUEST_PENDING");
  assert.equal((await getTemplate("BANK")).pending?.request_id, p.request_id);

  assert.equal(await code(decide(p.request_id, { ...checker, email: maker.email })), "SELF_APPROVAL");
  const applied = await decide(p.request_id) as { version: number };
  assert.equal(applied.version, baseline.BANK + 1);
  const t = await getTemplate("BANK");
  assert.equal(t.version, baseline.BANK + 1);
  assert.equal(t.pending, null);
  assert.ok(t.fields.some((f) => f.key === ref.key && f.requires_approval));
  assert.equal((await listVersions("BANK"))[0].approved_by, checker.email);
  assert.equal(await code(proposeVersion("BANK", [{ ...region, key: "name" }], maker)), "INVALID_TEMPLATE");
});

test("custom values: validated, applied at once, or through Maker-Checker when the field asks for it", opts, async () => {
  assert.equal(await code(setExtra("BANK", bankId, { [region.key]: "EAST" }, maker)), "INVALID_VALUES");
  assert.equal(await code(setExtra("BANK", bankId, { name: "Renamed" }, maker)), "INVALID_VALUES");
  const r = await setExtra("BANK", bankId, { [region.key]: "NORTH", [ref.key]: "ABC-1234" }, maker);
  assert.deepEqual(r.applied.map((c) => c.key), [region.key]);
  assert.deepEqual(r.pending.map((c) => c.key), [ref.key]);
  assert.ok(r.request_id);
  requests.push(r.request_id!);

  let rec = await getRecord("BANK", bankId);
  assert.deepEqual(rec.extra, { [region.key]: "NORTH" });
  assert.equal(rec.pending_extra?.request_id, r.request_id);
  assert.equal(rec.core.name, "Itest MDM Bank");
  assert.equal(rec.edit_href, "/banks");

  await decide(r.request_id!);
  rec = await getRecord("BANK", bankId);
  assert.deepEqual(rec.extra, { [region.key]: "NORTH", [ref.key]: "ABC-1234" });
  assert.deepEqual(rec.history.map((h) => h.kind).sort(), ["EXTRA_PROPOSED", "EXTRA_SET", "EXTRA_SET"]);
  const tsps = rec.relationships.find((x) => x.key === "tsps")!;
  assert.deepEqual(tsps.items.map((i) => i.id), [tspId]);

  const cleared = await setExtra("BANK", bankId, { [region.key]: null }, maker);
  assert.deepEqual(cleared.applied, [{ key: region.key, before: "NORTH", after: null }]);
  assert.deepEqual((await getRecord("BANK", bankId)).extra, { [ref.key]: "ABC-1234" });
});

test("the master list pages, searches and counts relationships", opts, async () => {
  const l = await listRecords("BANK", { q: `IMB${N}` });
  assert.equal(l.total, 1);
  assert.equal(l.rows[0].id, bankId);
  assert.equal(l.rows[0].relations.TSPs, 1);
  assert.equal(l.rows[0].extra[ref.key], "ABC-1234");
  assert.equal(l.page_size, 25);
  const t = await listRecords("TSP", { q: tspId });
  assert.equal(t.rows[0]?.relations.Banks, 1);
  const tr = await getRecord("TSP", tspId);
  assert.deepEqual(tr.relationships.find((x) => x.key === "banks")!.items.map((i) => i.id), [bankId]);
  assert.equal((await listRecords("BANKER", { page: 9999 })).rows.length, 0);
  assert.equal(await code(getRecord("BANK", "not-a-uuid")), "NOT_FOUND");
});

test("a merchant's custom values live in providerservice_db and are logged in the change log", opts, async (t) => {
  if (!providerId) return t.skip("no merchant in the local database");
  const p = await proposeVersion("MERCHANT", [...customFields((await getTemplate("MERCHANT")).fields), region], maker);
  requests.push(p.request_id);
  await decide(p.request_id);
  const r = await setExtra("MERCHANT", providerId, { [region.key]: "SOUTH" }, maker);
  assert.equal(r.applied.length, 1);
  const stored = await rows<{ extra: any }>("provider", `SELECT extra FROM providers WHERE id = $1::uuid`, [providerId]);
  assert.equal(stored[0].extra[region.key], "SOUTH");
  const rec = await getRecord("MERCHANT", providerId);
  assert.ok(rec.history.some((h) => h.kind === "EXTRA_SET" && h.field_key === region.key));
  assert.equal(rec.core.bank_account_no === true || rec.core.bank_account_no === false, true, "a sealed column only says whether it is set");
});

test("the change log and template versions are append-only", opts, async () => {
  await assert.rejects(rows("merchant", `UPDATE mdm_change_log SET actor = 'x' WHERE id = (SELECT MAX(id) FROM mdm_change_log)`), /append-only/);
  await assert.rejects(rows("merchant", `DELETE FROM mdm_template_versions WHERE type = 'BANK' AND version = 1`), /append-only/);
});

test("home has a card per master type", opts, async () => {
  const h = await home();
  assert.deepEqual(h.map((c) => c.type), [...MASTER_TYPES]);
  const bank = h.find((c) => c.type === "BANK")!;
  assert.equal(bank.version, baseline.BANK + 1);
  assert.ok((bank.records ?? 0) >= 1);
  assert.ok(bank.custom_fields >= 2);
});
