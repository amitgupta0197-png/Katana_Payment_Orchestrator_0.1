#!/usr/bin/env node
// Settlement E2E test — drives the full Upline↔Downline settlement lifecycle through
// the LIVE HTTP APIs with all three roles and asserts every step:
//
//   setup   : test provider + beneficiary + scoped pricing rule + USDT rate (BEP20)
//   bank    : raise (charges asserted) → accept → start → mandatory-data gate →
//             mark paid → receipt upload/download → confirm → reconcile → timeline
//   usdt    : raise (quantity asserted) → transfer with hash → confirm → reconcile
//   guards  : upline over-balance 409 · upline can't mark-paid · escalate → Katana
//   reports : recon CSV contains refs · notifications feed has events
//
// Runs ON the VPS (reads SESSION_SECRET from the app's .env.local, talks to
// 127.0.0.1:3100, cleans up its rows via psql). Sessions are minted directly with the
// same HMAC the app uses — no user provisioning needed.
//
//   node settlement-e2e.mjs [--keep]     (--keep = leave test rows for inspection)
//
// SAFETY: everything is scoped to provider TEST-E2E + branch TEST-BR-E2E; the pricing
// rule is scoped to that pair only. The BEP20 USDT rate is global — the script only
// declares one if none exists, and deletes it again unless --keep.

import { createHmac } from "crypto";
import { readFileSync } from "fs";
import { execFileSync } from "child_process";

const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:3100";
const ENV_FILE = process.env.E2E_ENV ?? "/opt/katana/apps/admin-dashboard/.env.local";
const KEEP = process.argv.includes("--keep");

const env = Object.fromEntries(
  readFileSync(ENV_FILE, "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const SECRET = env.SESSION_SECRET;
if (!SECRET) { console.error("SESSION_SECRET not found in " + ENV_FILE); process.exit(2); }

const BRANCH = "TEST-BR-E2E";
const PROVIDER_CODE = "TEST-E2E";

// ── helpers ──────────────────────────────────────────────────────────────────
const mint = (persona, scope_id, label) => {
  const body = Buffer.from(JSON.stringify({
    user_id: `e2e-${persona.toLowerCase()}`, email: `e2e-${persona.toLowerCase()}@test.local`,
    full_name: `E2E ${persona}`, persona, scope_id, scope_label: label ?? persona,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString("base64url");
  return `${body}.${createHmac("sha256", SECRET).update(body).digest("base64url")}`;
};

const psql = (sql, db = "providerservice_db") =>
  execFileSync("psql", ["-h", "127.0.0.1", "-U", "sixsenai", "-d", db, "-tAc", sql],
    { env: { ...process.env, PGPASSWORD: env.PG_PASSWORD }, encoding: "utf8" }).trim();

let passed = 0, failed = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const section = (t) => console.log(`\n■ ${t}`);

async function api(cookie, method, path, body, raw = false) {
  const init = { method, headers: { cookie: `katana_session=${cookie}` } };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  const r = await fetch(BASE + path, init);
  if (raw) return r;
  let data = null; try { data = await r.json(); } catch { /* non-json */ }
  return { status: r.status, data };
}
const act = (cookie, id, action, details, remarks) =>
  api(cookie, "POST", `/api/settlements/${id}/transition`, { action, details, remarks });

// 1×1 transparent PNG for the receipt upload.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

// ── run ──────────────────────────────────────────────────────────────────────
const admin = mint("SUPER_ADMIN", null, "Katana");
let providerId = null, createdRateId = null;

try {
  section("Setup");
  // Test provider (upsert by code) + a provider-scoped session.
  const prov = await api(admin, "POST", "/api/providers", {
    code: PROVIDER_CODE, legal_name: "E2E Test Provider", contact_email: "e2e@test.local", kind: "PROVIDER",
  });
  providerId = prov.data?.provider?.id ?? prov.data?.id
    ?? psql(`SELECT id FROM providers WHERE code='${PROVIDER_CODE}'`);
  ok("test provider exists", !!providerId, JSON.stringify(prov.data).slice(0, 120));
  const upline = mint("PROVIDER", providerId, "E2E Provider");
  const downline = mint("MERCHANT", BRANCH, "E2E Branch");

  // Beneficiary (reuse if present).
  let benId = psql(`SELECT id FROM provider_beneficiary_accounts WHERE provider_id='${providerId}' AND active LIMIT 1`);
  if (!benId) {
    const ben = await api(admin, "POST", `/api/providers/${providerId}/beneficiaries`, {
      beneficiary_name: "E2E Beneficiary", account_number: "000111222333", ifsc: "TEST0000001", bank_name: "Test Bank", transfer_mode: "IMPS",
    });
    benId = ben.data?.beneficiary?.id ?? psql(`SELECT id FROM provider_beneficiary_accounts WHERE provider_id='${providerId}' LIMIT 1`);
  }
  ok("beneficiary ready", !!benId);

  // Scoped pricing rule: 5.75% upline + 18% GST for (TEST provider, TEST branch) only.
  const rule = await api(admin, "POST", "/api/settlement-rules", {
    provider_id: providerId, merchant_key: BRANCH, upline_bps: 575, gst_bps: 1800, reason: "e2e automated test",
  });
  ok("scoped rule created", rule.status === 200, JSON.stringify(rule.data));

  // USDT rate on BEP20 (declare only when absent; remember for cleanup).
  const rates = await api(admin, "GET", "/api/usdt-rates");
  let bep = rates.data?.current?.BEP20;
  if (!bep) {
    const r = await api(admin, "POST", "/api/usdt-rates", { network: "BEP20", settlement_rate: 88.5, network_fee: 2 });
    createdRateId = r.data?.rate_id ?? null;
    bep = { settlement_rate: 88.5, network_fee: 2 };
  }
  ok("BEP20 USDT rate active", !!bep);

  // ── Bank settlement happy path ─────────────────────────────────────────────
  section("Bank settlement — full lifecycle");
  const raised = await api(admin, "POST", "/api/settlements", {
    provider_id: providerId, merchant_key: BRANCH, amount: 1000, beneficiary_id: benId, note: "e2e bank",
  });
  const st = raised.data?.settlement;
  ok("raise returns settlement", raised.status === 200 && !!st?.id, JSON.stringify(raised.data).slice(0, 160));
  ok("request ref assigned (KTN-SET-…)", /^KTN-SET-\d{6}$/.test(st?.request_ref ?? ""), st?.request_ref);
  ok("charges: gross 1000", Number(st?.gross_amount) === 1000, String(st?.gross_amount));
  // 5.75% = 57.50, GST 18% of 57.50 = 10.35 → net 932.15
  ok("charges: net 932.15 (5.75% + 18% GST)", Math.abs(Number(st?.net_amount) - 932.15) < 0.01, String(st?.net_amount));
  const id = st.id;

  const overBal = await api(upline, "POST", "/api/settlements", {
    merchant_key: BRANCH, amount: 100, beneficiary_id: benId,
  });
  ok("guard: upline over-balance raise → 409", overBal.status === 409, `${overBal.status} ${JSON.stringify(overBal.data)}`);

  ok("downline accept", (await act(downline, id, "ACCEPT")).data?.to === "ACCEPTED");
  ok("downline start processing", (await act(downline, id, "START")).data?.to === "PROCESSING");

  const uplinePaid = await act(upline, id, "MARK_PAID", { paid_amount: 932.15, payment_mode: "IMPS", payment_date: "2026-07-11", utr: "E2EUTR001", source_bank: "Test Bank" });
  ok("guard: upline cannot mark paid", uplinePaid.status !== 200, `${uplinePaid.status}`);

  const missing = await act(downline, id, "MARK_PAID", { payment_mode: "IMPS" });
  ok("guard: mark-paid without mandatory data → 409", missing.status === 409, JSON.stringify(missing.data));

  const paid = await act(downline, id, "MARK_PAID", { paid_amount: 932.15, payment_mode: "IMPS", payment_date: "2026-07-11", utr: "E2EUTR001", source_bank: "Test Bank" });
  ok("downline mark paid", paid.data?.to === "PAID", JSON.stringify(paid.data));

  const fd = new FormData();
  fd.append("file", new Blob([PNG], { type: "image/png" }), "receipt.png");
  const up = await api(downline, "POST", `/api/settlements/${id}/receipt`, fd);
  ok("receipt upload", up.status === 200, JSON.stringify(up.data));
  const dl = await api(upline, "GET", `/api/settlements/${id}/receipt`, undefined, true);
  ok("upline downloads receipt (image/png)", dl.status === 200 && (dl.headers.get("content-type") ?? "").includes("image/png"));

  ok("upline confirm receipt", (await act(upline, id, "CONFIRM")).data?.to === "VERIFIED");
  ok("admin reconcile", (await act(admin, id, "RECONCILE")).data?.to === "RECONCILED");

  const tl = await api(downline, "GET", `/api/settlements/${id}/timeline`);
  const evs = tl.data?.events ?? [];
  ok("timeline has full chain (≥7 events)", evs.length >= 7, `got ${evs.length}`);
  ok("timeline records receipt evidence", evs.some((e) => e.action === "UPLOAD_RECEIPT"));
  ok("timeline ends RECONCILED", evs[evs.length - 1]?.to_status === "RECONCILED");

  // ── USDT settlement ────────────────────────────────────────────────────────
  section("USDT settlement");
  const uRaise = await api(admin, "POST", "/api/settlements", {
    provider_id: providerId, merchant_key: BRANCH, amount: 1000, settle_mode: "USDT",
    usdt_network: "BEP20", wallet_address: "0xE2E0000000000000000000000000000000000001", note: "e2e usdt",
  });
  const ust = uRaise.data?.settlement;
  ok("USDT raise", uRaise.status === 200 && ust?.settle_mode === "USDT", JSON.stringify(uRaise.data).slice(0, 160));
  const expQty = Math.round((932.15 / bep.settlement_rate - (bep.network_fee || 0)) * 100) / 100;
  ok(`USDT quantity locked (${expQty})`, Math.abs(Number(ust?.usdt_quantity) - expQty) < 0.01, String(ust?.usdt_quantity));

  ok("accept", (await act(downline, ust.id, "ACCEPT")).data?.to === "ACCEPTED");
  ok("start", (await act(downline, ust.id, "START")).data?.to === "PROCESSING");
  const bankOnUsdt = await act(downline, ust.id, "MARK_PAID", { paid_amount: 1, payment_mode: "IMPS", payment_date: "2026-07-11", utr: "X", source_bank: "X" });
  ok("guard: bank mark-paid blocked on USDT", bankOnUsdt.status !== 200, `${bankOnUsdt.status}`);
  const xfer = await act(downline, ust.id, "MARK_USDT_TRANSFERRED", { tx_hash: "0xe2ehash" + Date.now(), usdt_quantity: expQty, usdt_rate: bep.settlement_rate });
  ok("USDT transferred with hash", xfer.data?.to === "USDT_TRANSFERRED", JSON.stringify(xfer.data));
  ok("upline confirm", (await act(upline, ust.id, "CONFIRM")).data?.to === "VERIFIED");
  ok("admin reconcile", (await act(admin, ust.id, "RECONCILE")).data?.to === "RECONCILED");

  // ── Vendor registry ────────────────────────────────────────────────────────
  section("Vendor registry");
  const v = await api(upline, "POST", `/api/providers/${providerId}/vendors`, {
    vendor_name: "E2E Vendor", beneficiary_name: "E2E Vendor Account",
    account_number: "999888777666", ifsc: "TEST0000002", category: "SUPPLIER", pan: "ABCDE1234F",
  });
  const vid = v.data?.vendor_id;
  ok("vendor created", v.status === 200 && !!vid, JSON.stringify(v.data));

  const vRaise = await api(admin, "POST", "/api/settlements", {
    provider_id: providerId, merchant_key: BRANCH, amount: 200, vendor_id: vid, note: "e2e vendor pay",
  });
  const vsId = vRaise.data?.settlement?.id;
  ok("settlement raised paying the vendor", vRaise.status === 200 && !!vsId);
  const dlList = await api(downline, "GET", "/api/settlements");
  const vRow = (dlList.data?.settlements ?? []).find((x) => x.id === vsId);
  ok("downline sees the vendor snapshot", vRow?.beneficiary_snapshot?.beneficiary_name === "E2E Vendor Account",
    JSON.stringify(vRow?.beneficiary_snapshot ?? null));

  await api(upline, "PATCH", `/api/providers/${providerId}/vendors/${vid}`, { status: "BLOCKED" });
  const blockedRaise = await api(admin, "POST", "/api/settlements", {
    provider_id: providerId, merchant_key: BRANCH, amount: 200, vendor_id: vid,
  });
  ok("guard: BLOCKED vendor cannot receive a settlement (409)", blockedRaise.status === 409, `${blockedRaise.status}`);

  // ── Webhook notifications ──────────────────────────────────────────────────
  section("Webhook notifications");
  const { createServer } = await import("http");
  const hits = [];
  const srv = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => { hits.push({ sig: req.headers["x-katana-signature"], event: req.headers["x-katana-event"], body: raw }); res.end("ok"); });
  });
  await new Promise((res) => srv.listen(0, "127.0.0.1", res));
  const port = srv.address().port;
  const ch = await api(upline, "POST", `/api/providers/${providerId}/notify-channels`, {
    kind: "WEBHOOK", target: `http://127.0.0.1:${port}/hook`,
  });
  ok("webhook channel registered", ch.status === 200, JSON.stringify(ch.data));
  await act(downline, vsId, "ACCEPT");
  await new Promise((r) => setTimeout(r, 1500));
  ok("webhook received the status change", hits.length >= 1, `hits=${hits.length}`);
  ok("webhook is signed + carries the event", !!hits[0]?.sig && String(hits[0]?.event ?? "").startsWith("settlement."),
    JSON.stringify({ sig: !!hits[0]?.sig, event: hits[0]?.event }));
  ok("webhook payload has ref + status", (() => { try { const p = JSON.parse(hits[0].body); return !!p.request_ref && p.to_status === "ACCEPTED"; } catch { return false; } })());
  await api(upline, "DELETE", `/api/providers/${providerId}/notify-channels?channel=${ch.data.channel_id}`);
  srv.close();

  // ── Escalation ─────────────────────────────────────────────────────────────
  section("Escalation to Katana");
  const e = await api(admin, "POST", "/api/settlements", { provider_id: providerId, merchant_key: BRANCH, amount: 500, beneficiary_id: benId, note: "e2e escalate" });
  const eid = e.data?.settlement?.id;
  ok("raise", !!eid);
  ok("downline escalates (reason required)", (await act(downline, eid, "ESCALATE", { reason: "no liquidity" })).data?.to === "ESCALATED");
  ok("Katana takes over → PROCESSING", (await act(admin, eid, "PROCESS_ESCALATED")).data?.to === "PROCESSING");

  // ── Refinements: capacity, priority, clarify, lock, insufficient, reassign ─
  section("Refinements");
  const capSet = await api(downline, "POST", "/api/branch-capacity", {
    bank_available: true, usdt_available: true, usdt_quantity: 5000, usdt_network: "BEP20", daily_capacity: 100000, note: "e2e",
  });
  ok("downline declares capacity", capSet.status === 200, JSON.stringify(capSet.data));
  const capGet = await api(admin, "GET", `/api/branch-capacity?branch=${encodeURIComponent(capSet.data?.branch ?? BRANCH)}`);
  ok("capacity visible to admin/upline", (capGet.data?.capacity ?? []).some((c) => Number(c.usdt_quantity) === 5000));

  const pr = await api(admin, "POST", "/api/settlements", {
    provider_id: providerId, merchant_key: BRANCH, amount: 300, beneficiary_id: benId,
    priority: "HIGH", internal_ref: "INV-E2E-1", requested_date: "2026-07-15",
  });
  const prId = pr.data?.settlement?.id;
  ok("raise with priority / internal ref / date", pr.status === 200 && !!prId);
  const prRow = ((await api(upline, "GET", "/api/settlements")).data?.settlements ?? []).find((x) => x.id === prId);
  ok("priority + internal ref round-trip", prRow?.priority === "HIGH" && prRow?.internal_ref === "INV-E2E-1",
    JSON.stringify({ p: prRow?.priority, r: prRow?.internal_ref }));

  const cl = await act(upline, prId, "CLARIFY", { reason: "please confirm beneficiary name" });
  ok("clarify logs event, status unchanged", cl.status === 200 && cl.data?.to === "REQUESTED", JSON.stringify(cl.data));

  ok("admin locks", (await act(admin, prId, "LOCK", { reason: "e2e freeze" })).status === 200);
  const lockedAct = await act(downline, prId, "ACCEPT");
  ok("locked settlement blocks the downline (409)", lockedAct.status === 409, `${lockedAct.status}`);
  ok("admin unlocks", (await act(admin, prId, "UNLOCK")).status === 200);
  ok("downline can act after unlock", (await act(downline, prId, "ACCEPT")).data?.to === "ACCEPTED");

  const outBefore = (await api(admin, "GET", `/api/settlements/outstanding?provider=${providerId}&branch=${BRANCH}`)).data;
  const insuf = await act(downline, prId, "MARK_INSUFFICIENT", { reason: "no funds today" });
  ok("insufficient-balance status", insuf.data?.to === "INSUFFICIENT_BALANCE", JSON.stringify(insuf.data));
  const outAfter = (await api(admin, "GET", `/api/settlements/outstanding?provider=${providerId}&branch=${BRANCH}`)).data;
  ok("blocked balance released (₹300 freed)", Math.abs((Number(outBefore?.blocked) - Number(outAfter?.blocked)) - 300) < 0.01,
    `before=${outBefore?.blocked} after=${outAfter?.blocked}`);

  const re = await act(admin, prId, "REASSIGN", { new_branch: "TEST-BR-E2E-2", reason: "moving to backup branch" });
  ok("admin reassigns downline → back to REQUESTED", re.status === 200 && re.data?.to === "REQUESTED", JSON.stringify(re.data));
  const reRow = ((await api(admin, "GET", `/api/settlements?provider=${providerId}`)).data?.settlements ?? []).find((x) => x.id === prId);
  ok("settlement now addressed to the new branch", reRow?.merchant_key === "TEST-BR-E2E-2", reRow?.merchant_key);

  // ── Reports & notifications ────────────────────────────────────────────────
  section("Reports & notifications");
  const csvR = await api(upline, "GET", "/api/settlements/export", undefined, true);
  const csv = await csvR.text();
  ok("recon CSV downloads", csvR.status === 200 && csv.startsWith("request_id,"));
  ok("CSV contains the test settlements", csv.includes(st.request_ref) && csv.includes("932.15"));
  const notif = await api(upline, "GET", "/api/settlements/notifications");
  ok("notifications feed has events", (notif.data?.events ?? []).length >= 5, `got ${(notif.data?.events ?? []).length}`);
  ok("feed carries the request ref", (notif.data?.events ?? []).some((x) => x.request_ref === st.request_ref));
} catch (err) {
  failed++;
  console.error("\n✗ UNEXPECTED ERROR:", err.message ?? err);
} finally {
  if (!KEEP && providerId) {
    section("Cleanup");
    try {
      psql(`DELETE FROM provider_settlement_events WHERE provider_id='${providerId}'`);
      psql(`DELETE FROM provider_branch_settlements WHERE provider_id='${providerId}'`);
      psql(`DELETE FROM provider_settlement_rules WHERE provider_id='${providerId}'`);
      psql(`DELETE FROM provider_vendor_documents WHERE vendor_id IN (SELECT id FROM provider_vendors WHERE provider_id='${providerId}')`);
      psql(`DELETE FROM provider_vendors WHERE provider_id='${providerId}'`);
      psql(`DELETE FROM provider_notification_channels WHERE provider_id='${providerId}'`);
      psql(`DELETE FROM provider_branch_capacity WHERE merchant_key IN ('${BRANCH}','TEST-BR-E2E-2')`);
      if (createdRateId) psql(`DELETE FROM provider_usdt_rates WHERE id='${createdRateId}'`);
      console.log("  test settlements/rules/events removed (provider + beneficiary kept for reruns)");
    } catch (e) { console.log("  cleanup issue:", e.message); }
  } else if (KEEP) console.log("\n(kept test rows — inspect them in the dashboards, rerun without --keep to clean)");
}

console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
