// Merchant onboarding, end to end, over HTTP against a running local server: every combination
// of services (pay-in, pay-out, both) and pay-in flow (P2P, Intent, Both with either in use) is
// created through the dashboard's own routes, its banker is taken to go-live, and every order
// and payout API is called to check what is taken and what is refused.
//
//   pnpm dev            (in another terminal)
//   pnpm test:e2e
//
// IT WRITES ROWS, so it only runs against a local database and a server on localhost, and it
// removes what it created. It is skipped when no server answers. Orders are TEST orders: no
// gateway is called and no money moves.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { rows } from "@/lib/pg";
import { ensureLocalStaff, LOCAL } from "./local-staff";
import { runSupportTool } from "@/lib/support-bot/tools";

const BASE = (process.env.E2E_BASE_URL ?? "http://localhost:3100").replace(/\/$/, "");
const LOCAL_SERVER = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(BASE);
const RUN = Date.now().toString(36).toUpperCase();
const PROVIDER_PREFIX = "E2E-";
const BANKER_PREFIX = "E2EB";

type Services = "PAYIN" | "PAYOUT" | "BOTH";
type Flow = "P2P" | "INTENT" | "BOTH";
type OrderFlow = "P2P" | "INTENT";
interface Combo { name: string; services: Services; flow: Flow | null; active: OrderFlow | null }

const COMBOS: Combo[] = [
  { name: "pay-in, P2P", services: "PAYIN", flow: "P2P", active: null },
  { name: "pay-in, Intent", services: "PAYIN", flow: "INTENT", active: null },
  { name: "pay-in, Both with P2P in use", services: "PAYIN", flow: "BOTH", active: "P2P" },
  { name: "pay-in, Both with Intent in use", services: "PAYIN", flow: "BOTH", active: "INTENT" },
  { name: "both services, P2P", services: "BOTH", flow: "P2P", active: null },
  { name: "both services, Intent", services: "BOTH", flow: "INTENT", active: null },
  { name: "both services, Both with P2P in use", services: "BOTH", flow: "BOTH", active: "P2P" },
  { name: "both services, Both with Intent in use", services: "BOTH", flow: "BOTH", active: "INTENT" },
  { name: "pay-out only", services: "PAYOUT", flow: null, active: null },
];
/** The flow a banker's orders take on the general API. */
const inUse = (c: Combo): OrderFlow | null => (c.flow === "BOTH" ? c.active : c.flow);
const allows = (c: Combo, f: OrderFlow) => c.flow === "BOTH" || c.flow === f;

let staffCookie = "";
let up = false;
let n = 0;

async function login(email: string, password: string): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`login as ${email} failed: ${r.status} ${await r.text()}`);
  return r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

async function api(method: string, path: string, body?: unknown, cookie = staffCookie): Promise<{ status: number; body: any }> {
  const r = await fetch(`${BASE}${path}`, {
    method, redirect: "manual",
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

interface Creds { key: string; salt: string; scheme: string }
const orderHash = (c: Creds, o: { txnid: string; amount: string; productinfo: string; email: string }) =>
  crypto.createHmac("sha256", c.key + c.salt).update([o.txnid, o.amount, o.productinfo, o.email].join("|")).digest("hex");
const payoutHash = (c: Creds, fields: (string | undefined)[]) =>
  crypto.createHmac("sha256", c.key + c.salt).update(fields.map((f) => f ?? "").join("|")).digest("hex");

async function order(c: Creds, path: string) {
  const o = { txnid: `E2E-${RUN}-${n++}`, amount: "25.00", productinfo: "e2e", email: "payer@katana.test" };
  return api("POST", path, { key: c.key, ...o, hash: orderHash(c, o) }, "");
}

async function cleanup() {
  const bankers = await rows<{ id: string; merchant_code: string }>("merchant",
    `SELECT id::text, merchant_code FROM merchants WHERE merchant_code LIKE $1`, [`${BANKER_PREFIX}%`]);
  const codes = bankers.map((b) => b.merchant_code), ids = bankers.map((b) => b.id);
  const quiet = (p: Promise<unknown>) => p.catch(() => {});
  await quiet(rows("fifo", `DELETE FROM fifo_fraud_alerts WHERE merchant_id = ANY($1::text[])`, [codes]));
  await quiet(rows("fifo", `DELETE FROM fifo_approvals WHERE merchant_id = ANY($1::text[])`, [codes]));
  await quiet(rows("fifo", `DELETE FROM fifo_order_events WHERE order_id IN (SELECT id FROM fifo_orders WHERE merchant_id = ANY($1::text[]))`, [codes]));
  await quiet(rows("fifo", `DELETE FROM fifo_orders WHERE merchant_id = ANY($1::text[])`, [codes]));
  await quiet(rows("fifo", `DELETE FROM fifo_beneficiaries WHERE merchant_id = ANY($1::text[])`, [codes]));
  await quiet(rows("vendorGateway", `DELETE FROM vendor_payin_orders WHERE merchant_id = ANY($1::text[])`, [codes]));
  await quiet(rows("audit", `DELETE FROM api_request_log WHERE merchant_id = ANY($1::text[])`, [codes]));
  await quiet(rows("merchant", `DELETE FROM support_bot_conversations WHERE merchant_code = ANY($1::text[])`, [codes]));
  await quiet(rows("merchant", `DELETE FROM support_bot_conversations WHERE scope_key IN (SELECT 'merchant:' || id::text FROM unnest($1::text[]) AS id) OR merchant_code = 'E2E-OTHER'`,
    [(await rows<{ id: string }>("provider", `SELECT id::text FROM providers WHERE code LIKE $1`, [`${PROVIDER_PREFIX}%`]).catch(() => [])).map((p) => p.id)]));
  await quiet(rows("checkout", `DELETE FROM merchant_checkout_keys WHERE merchant_code = ANY($1::text[])`, [codes]));
  await quiet(rows("checkout", `DELETE FROM credential_vault WHERE owner_type = 'merchant' AND owner_id = ANY($1::text[])`, [codes]));
  await quiet(rows("provider", `DELETE FROM provider_merchant_mappings WHERE merchant_id::text = ANY($1::text[])`, [[...ids, ...codes]]));
  await quiet(rows("provider", `DELETE FROM providers WHERE code LIKE $1`, [`${PROVIDER_PREFIX}%`]));
  await quiet(rows("merchant", `DELETE FROM merchant_payment_config WHERE merchant_code = ANY($1::text[])`, [codes]));
  await quiet(rows("merchant", `DELETE FROM merchant_live_activation WHERE merchant_code = ANY($1::text[])`, [codes]));
  await quiet(rows("merchant", `DELETE FROM merchant_onboarding_gates WHERE merchant_id::text = ANY($1::text[])`, [ids]));
  await quiet(rows("merchant", `DELETE FROM merchant_activity WHERE merchant_id::text = ANY($1::text[])`, [ids]));
  await quiet(rows("merchant", `DELETE FROM merchants WHERE merchant_code = ANY($1::text[])`, [codes]));
  const users = await rows<{ id: string }>("auth", `SELECT id::text FROM users WHERE email LIKE 'e2e-banker-%@katana.test' OR email LIKE 'e2e-p-%@katana.test'`).catch(() => []);
  await quiet(rows("iam", `DELETE FROM user_personas WHERE user_id::text = ANY($1::text[])`, [users.map((u) => u.id)]));
  await quiet(rows("auth", `DELETE FROM users WHERE email LIKE 'e2e-banker-%@katana.test' OR email LIKE 'e2e-p-%@katana.test'`));
}

before(async () => {
  if (!LOCAL || !LOCAL_SERVER) return;
  up = await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false);
  if (!up) return;
  await cleanup();
  const staff = await ensureLocalStaff();
  staffCookie = await login(staff.email, staff.password);
});
after(async () => { if (up) await cleanup(); setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref(); });

const skip = () => (!LOCAL ? "refusing to write to a non-local database"
  : !LOCAL_SERVER ? `refusing to run against ${BASE}: not a local server`
  : !up ? `no server at ${BASE}: start it with pnpm dev` : false);

test("a merchant cannot be created with a choice that makes no sense", async (t) => {
  const why = skip(); if (why) return t.skip(why);
  const base = { legal_name: "E2E Bad Choice", contact_email: "e2e-bad@katana.test", kind: "PROVIDER" };
  const cases: [Record<string, string>, RegExp][] = [
    [{ services: "PAYIN" }, /select the pay-in flow/],
    [{ services: "BOTH" }, /select the pay-in flow/],
    [{ services: "PAYIN", payin_flow: "BOTH" }, /select the default flow/],
    [{ services: "PAYIN", payin_flow: "P2P", payin_active_flow: "P2P" }, /default flow is only selected for Both/],
    [{ services: "PAYOUT", payin_flow: "P2P" }, /no pay-in flow/],
    [{ payin_flow: "P2P" }, /select the services/],
  ];
  for (const [choice, message] of cases) {
    const code = `${PROVIDER_PREFIX}${RUN}-BAD${n++}`;
    const r = await api("POST", "/api/providers", { ...base, code, ...choice });
    assert.equal(r.status, 400, JSON.stringify(choice));
    assert.match(r.body.error, message);
    assert.equal((await rows("provider", `SELECT 1 FROM providers WHERE code = $1`, [code])).length, 0, "nothing is created");
  }

  // A code is unique: the journey is told whether it is free, and the server refuses a taken one.
  const code = `${PROVIDER_PREFIX}${RUN}-DUP`;
  const first = await api("POST", "/api/providers", { ...base, code, services: "PAYOUT", create_only: true });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const check = await api("GET", `/api/providers/code?name=${encodeURIComponent("E2E Bad Choice")}&code=${code.toLowerCase()}`);
  assert.deepEqual([check.status, check.body.available], [200, false]);
  assert.match(check.body.suggestion, /^E2E-BAD/);
  const again = await api("POST", "/api/providers", { ...base, legal_name: "E2E Someone Else", code: code.toLowerCase(), services: "PAYOUT", create_only: true });
  assert.deepEqual([again.status, again.body.code], [409, "CODE_TAKEN"]);
  const kept = (await rows<{ legal_name: string }>("provider", `SELECT legal_name FROM providers WHERE code = $1`, [code]))[0];
  assert.equal(kept.legal_name, base.legal_name, "the merchant that has the code is not overwritten");
});

for (const [i, c] of COMBOS.entries()) {
  test(`${c.name}: created, taken to go-live, and every API takes or refuses what it should`, async (t) => {
    const why = skip(); if (why) return t.skip(why);
    const code = `${PROVIDER_PREFIX}${RUN}-${i}`, bankerCode = `${BANKER_PREFIX}${RUN}${i}`;
    const bankerEmail = `e2e-banker-${RUN.toLowerCase()}-${i}@katana.test`;

    // ── 1. Create the merchant with its first banker, as the Create merchant dialog does.
    const made = await api("POST", "/api/providers", {
      code, legal_name: `E2E ${c.name}`, contact_email: `e2e-m-${RUN.toLowerCase()}-${i}@katana.test`, kind: "PROVIDER",
      services: c.services, ...(c.flow ? { payin_flow: c.flow } : {}), ...(c.active ? { payin_active_flow: c.active } : {}),
      initial_branch: { merchant_code: bankerCode, legal_name: `E2E Banker ${i}`, contact_email: bankerEmail },
    });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    assert.equal(made.body.services, c.services);
    assert.equal(made.body.payin_flow ?? null, c.flow);
    assert.equal(made.body.branch?.merchant_code, bankerCode, JSON.stringify(made.body.branch));
    const providerId = made.body.id as string;
    const bankerId = (await rows<{ id: string }>("merchant", `SELECT id::text FROM merchants WHERE merchant_code = $1`, [bankerCode]))[0].id;

    // What was chosen is what is stored, with a history row for each.
    const svc = await api("GET", `/api/providers/${providerId}/services`);
    assert.deepEqual([svc.status, svc.body.services, svc.body.history.length], [200, c.services, 1]);
    const flow = await api("GET", `/api/providers/${providerId}/payin-flow`);
    assert.deepEqual([flow.body.flow, flow.body.active], [c.flow ?? "UNSET", c.active]);

    // ── 2. The banker's onboarding. The KYB steps are not what is under test: overridden.
    for (const step of ["step_application", "step_kyb_docs", "step_screening", "step_bank_verify", "step_config"]) {
      const r = await api("POST", `/api/merchants/${bankerId}/advance`, { step, override: true, notes: "e2e: KYB is not under test" });
      assert.equal(r.status, 200, `${step}: ${JSON.stringify(r.body)}`);
    }
    // Before go-live the card says what is needed for this merchant's choice.
    const card = await api("GET", `/api/merchants/${bankerId}/onboarding-gates`);
    assert.deepEqual([card.body.setup.services, card.body.setup.flow.flow], [c.services, c.flow ?? "UNSET"]);
    const need = (k: string) => card.body.setup.items.find((x: { key: string }) => x.key === k)?.state ?? null;
    assert.equal(need("P2P_UPI_ID"), !c.flow || !allows(c, "P2P") ? null : inUse(c) === "P2P" ? "MISSING" : "OPTIONAL_MISSING");
    assert.equal(need("INTENT_GATEWAY"), !c.flow || !allows(c, "INTENT") ? null : inUse(c) === "INTENT" ? "MISSING" : "OPTIONAL_MISSING");
    assert.equal(need("PAYOUT_GATEWAY"), c.services === "PAYIN" ? null : "OPTIONAL_MISSING");

    // Go-live is refused while the flow in use is not set up; a pay-out only banker has nothing to set up.
    let live = await api("POST", `/api/merchants/${bankerId}/advance`, { step: "step_approval" });
    if (c.services === "PAYOUT") {
      assert.equal(live.status, 200, JSON.stringify(live.body));
    } else {
      assert.deepEqual([live.status, live.body.code, live.body.gates?.[0]?.gate], [409, "GATE_FAILED", "SETUP"], JSON.stringify(live.body));
      if (inUse(c) === "P2P") {
        // P2P: saving the settlement UPI ID is what go-live was waiting for.
        const cfg = await api("PATCH", `/api/merchants/${bankerId}/payment-config`, { katana_pay: { settlement_vpa: `e2e${i}@upi` } });
        assert.equal(cfg.status, 200, JSON.stringify(cfg.body));
        live = await api("POST", `/api/merchants/${bankerId}/advance`, { step: "step_approval" });
      } else {
        // Intent: a gateway cannot be connected in a test, so a Super Admin lets it through with a note.
        const bare = await api("POST", `/api/merchants/${bankerId}/advance`, { step: "step_approval", override: true });
        assert.equal(bare.status, 400, "an override needs a note");
        live = await api("POST", `/api/merchants/${bankerId}/advance`, { step: "step_approval", override: true, notes: "e2e: no gateway in a test" });
      }
      assert.equal(live.status, 200, JSON.stringify(live.body));
    }
    assert.equal(live.body.stage, "LIVE");
    const gates = await api("GET", `/api/merchants/${bankerId}/onboarding-gates`);
    const setupGate = gates.body.gates.find((g: { gate: string }) => g.gate === "SETUP");
    assert.ok(setupGate, "the SETUP gate run is recorded");

    // ── 3. The live-activation checklist asks for what this merchant was onboarded for.
    const act = await api("GET", `/api/merchants/${bankerId}/live-activation`);
    assert.equal(act.status, 200, JSON.stringify(act.body));
    const keys = (act.body.checklist ?? act.body.state?.checklist ?? []).map((x: { key: string }) => x.key).sort();
    const want = c.services === "PAYOUT" ? ["onboarding", "test_payout", "webhook_url"]
      : inUse(c) === "INTENT" ? ["onboarding", "payin_gateway", "test_payment", "webhook_url"]
      : ["onboarding", "settlement_vpa", "test_payment", "webhook_url"];
    assert.deepEqual(keys, want);

    // ── 3b. The Starter Kit is ready without anyone making keys first: it makes the test pair.
    const firstKit = await api("GET", `/api/merchants/${bankerId}/starter-kit?format=plain`);
    assert.deepEqual([firstKit.status, firstKit.body.issued_test_keys], [200, true], JSON.stringify(firstKit.body));
    assert.match(firstKit.body.parts[0].text, /Key: mk_test_[0-9a-f]+\nSalt: [0-9a-f]{32}/);
    assert.equal((await api("GET", `/api/merchants/${bankerId}/starter-kit`)).body.issued_test_keys, false, "an existing pair is kept");

    // ── 4. A test Key + Salt, then every order API.
    const issued = await api("POST", `/api/merchants/${bankerId}/checkout-key`, { livemode: false });
    assert.ok(issued.status < 300, JSON.stringify(issued.body));
    const creds = (issued.body.creds ?? issued.body) as Creds;
    assert.ok(creds.key?.startsWith("mk_test_") && creds.salt, "a test pair is issued");

    const general = await order(creds, "/api/v1/katana-pay/order");
    const p2p = await order(creds, "/api/v1/p2p/order");
    const intent = await order(creds, "/api/v1/intent/order");
    if (c.services === "PAYOUT") {
      for (const r of [general, p2p, intent]) assert.deepEqual([r.status, r.body.code], [403, "PAYIN_NOT_ENABLED"]);
    } else {
      assert.equal(general.status, 201, JSON.stringify(general.body));
      assert.equal(general.body.flow, inUse(c));
      assert.equal(typeof general.body.pay_url, "string");
      assert.deepEqual(allows(c, "P2P") ? [p2p.status, p2p.body.flow] : [p2p.status, p2p.body.code], allows(c, "P2P") ? [201, "P2P"] : [409, "FLOW_NOT_ENABLED"]);
      assert.deepEqual(allows(c, "INTENT") ? [intent.status, intent.body.flow] : [intent.status, intent.body.code], allows(c, "INTENT") ? [201, "INTENT"] : [409, "FLOW_NOT_ENABLED"]);
      // No answer to a merchant ever names a gateway.
      // (PhonePe and Paytm are left out: they are also UPI apps, and the answer carries app links.)
      assert.equal(/payu|razorpay|cashfree|ccavenue|rubyvault|ismartpay/i.test(JSON.stringify([general.body, p2p.body, intent.body])), false);

      // Each order is found by the status API of its own flow, and not by the other's.
      for (const [r, f] of [[p2p, "P2P"], [intent, "INTENT"]] as const) {
        if (r.status !== 201) continue;
        const mineFlow = await api("GET", `/api/v1/${f === "P2P" ? "p2p" : "intent"}/order/${r.body.order.id}`, undefined, "");
        assert.deepEqual([mineFlow.status, mineFlow.body.flow, mineFlow.body.status], [200, f, "PENDING"], JSON.stringify(mineFlow.body));
        const other = await api("GET", `/api/v1/${f === "P2P" ? "intent" : "p2p"}/order/${r.body.order.id}`, undefined, "");
        assert.equal(other.status, 404);
      }
      // A test payment is completed the way the test pay page does it, and the order is paid.
      const paid = await api("POST", `/api/pay-status/${general.body.order.id}/simulate`, { outcome: "SUCCESS" }, "");
      assert.equal(paid.status, 200, JSON.stringify(paid.body));
      const after = await api("GET", `/api/pay-status/${general.body.order.id}`, undefined, "");
      assert.deepEqual([after.body.status, after.body.terminal], ["SUCCESS", true]);
    }

    // ── 5. The payout API.
    const txnid = `E2E-PO-${RUN}-${i}`, ben = "e2e-ben";
    const po = await api("POST", "/api/v1/payouts/create",
      { key: creds.key, txnid, amount: "10.00", beneficiary_ref: ben, hash: payoutHash(creds, [txnid, "10.00", ben, undefined, undefined]) }, "");
    if (c.services === "PAYIN") {
      assert.deepEqual([po.status, po.body.code], [403, "PAYOUT_NOT_ENABLED"]);
      const b = { beneficiary_ref: ben, name: "E2E Beneficiary", upi_id: "e2e-ben@upi" };
      const reg = await api("POST", "/api/v1/payouts/beneficiaries",
        { key: creds.key, ...b, hash: payoutHash(creds, [b.beneficiary_ref, b.name, undefined, undefined, b.upi_id]) }, "");
      assert.deepEqual([reg.status, reg.body.code], [403, "PAYOUT_NOT_ENABLED"]);
    } else {
      // Past the services check: it stops at the beneficiary, which does not exist.
      assert.deepEqual([po.status, po.body.code], [404, undefined], JSON.stringify(po.body));

      // ── 5a. Test payouts go to Katana's payout sandbox. A beneficiary added with the test key
      //        is approved at once, for test payouts only.
      const b = { beneficiary_ref: ben, name: "E2E Beneficiary", upi_id: "e2e-ben@upi" };
      const reg = await api("POST", "/api/v1/payouts/beneficiaries",
        { key: creds.key, ...b, hash: payoutHash(creds, [b.beneficiary_ref, b.name, undefined, undefined, b.upi_id]) }, "");
      assert.equal(reg.status, 201, JSON.stringify(reg.body));
      assert.deepEqual([reg.body.beneficiary.status, reg.body.beneficiary.livemode], ["APPROVED", false]);
      const pay = (txn: string, amount: string) => api("POST", "/api/v1/payouts/create",
        { key: creds.key, txnid: txn, amount, beneficiary_ref: ben, hash: payoutHash(creds, [txn, amount, ben, undefined, undefined]) }, "");
      const ok = await pay(`${txnid}-OK`, "10.99");
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      assert.deepEqual([ok.body.payout.status, ok.body.payout.livemode, ok.body.approval_required], ["SUCCESS", false, false]);
      assert.match(ok.body.payout.utr, /^SBX\d{9}$/);
      const bad = await pay(`${txnid}-BAD`, "10.13");
      assert.deepEqual([bad.status, bad.body.payout.status], [201, "FAILED"], JSON.stringify(bad.body));
      assert.match(bad.body.payout.failure_reason, /\.13/);
      // A high-value test payout moves no money: it is not held for a second person.
      const big = await pay(`${txnid}-BIG`, "60000.99");
      assert.deepEqual([big.body.payout.status, big.body.approval_required], ["SUCCESS", false], JSON.stringify(big.body));
      const slow = await pay(`${txnid}-SLOW`, "10.00");
      assert.deepEqual([slow.status, slow.body.payout.status], [201, "PROCESSING"], JSON.stringify(slow.body));
      const statusHash = payoutHash(creds, [`${txnid}-SLOW`]);
      const before = await api("POST", "/api/v1/payouts/status", { key: creds.key, txnid: `${txnid}-SLOW`, hash: statusHash }, "");
      assert.deepEqual([before.status, before.body.payout.status], [200, "PROCESSING"]);
      // The sweep settles it once the sandbox's time has passed; "Check status" asks the same way.
      await new Promise((r) => setTimeout(r, 11_000));
      const checked = await api("POST", `/api/v1/payouts/${slow.body.payout.payout_id}/check`);
      assert.deepEqual([checked.status, checked.body.status], [200, "COMPLETED"], JSON.stringify(checked.body));
      const afterSlow = await api("POST", "/api/v1/payouts/status", { key: creds.key, txnid: `${txnid}-SLOW`, hash: statusHash }, "");
      assert.equal(afterSlow.body.payout.status, "SUCCESS");
      // Nothing in a test payout reached a ledger or the operator queue.
      const ids = (await rows<{ id: string }>("fifo", `SELECT id::text FROM fifo_orders WHERE merchant_id = $1 AND direction = 'PAYOUT'`, [bankerCode])).map((r) => r.id);
      assert.equal((await rows("fifo", `SELECT 1 FROM fifo_queue WHERE order_id::text = ANY($1::text[])`, [ids])).length, 0);
      assert.equal((await rows("fifo", `SELECT 1 FROM fifo_approvals WHERE merchant_id = $1`, [bankerCode])).length, 0);
      if (c.services === "PAYOUT") {
        const done = await api("GET", `/api/merchants/${bankerId}/live-activation`);
        const item = (done.body.checklist ?? done.body.state?.checklist).find((x: { key: string }) => x.key === "test_payout");
        assert.equal(item.done, true, "the go-live checklist sees the test payout");
      }
    }

    // ── 5b. The Starter Kit follows the choice, carries the current test pair, and its own
    //        example requests work when pasted into a shell.
    for (const format of ["whatsapp", "telegram", "plain"]) {
      const k = await api("GET", `/api/merchants/${bankerId}/starter-kit?format=${format}`);
      assert.equal(k.status, 200, JSON.stringify(k.body));
      const text = k.body.parts.map((p: { text: string }) => p.text).join("\n\n");
      assert.ok(text.includes(creds.key) && text.includes(creds.salt), `${format}: the current test pair`);
      assert.equal(/payu|razorpay|cashfree|ccavenue|rubyvault|ismartpay|phonepe pg|paytm pg/i.test(text), false, `${format}: no gateway named`);
      assert.ok(k.body.parts.every((p: { text: string }) => p.text.length < 4096), `${format}: every message fits Telegram`);
      assert.equal(/\/order\b/.test(text), c.services !== "PAYOUT", `${format}: pay-in endpoints only for pay-in`);
      assert.equal(text.includes("/api/v1/payouts/create"), c.services !== "PAYIN", `${format}: payout endpoints only for pay-out`);
      if (c.flow === "P2P") assert.ok(text.includes("/api/v1/p2p/order") && !text.includes("/api/v1/intent/order"));
      if (c.flow === "INTENT") assert.ok(text.includes("/api/v1/intent/order") && !text.includes("/api/v1/p2p/order"));
    }
    const plain = (await api("GET", `/api/merchants/${bankerId}/starter-kit?format=plain`)).body.parts as { title: string; text: string }[];
    // A block of the plain kit is indented four spaces. Run it exactly as pasted, with this
    // server in place of the public address.
    const runBlock = (title: string) => {
      const part = plain.find((p) => p.title === title);
      assert.ok(part, `kit has "${title}"`);
      const script = part!.text.split("\n").filter((l) => l.startsWith("    ")).map((l) => l.slice(4)).join("\n")
        .replace(/https?:\/\/[^\s/]+(?=\/api\/)/g, BASE);
      const out = execFileSync("bash", ["-c", script.replace(/curl -X/g, "curl -s -X")], { encoding: "utf8" });
      // One JSON answer per curl in the block; the last one is what it was for.
      const answers = out.replace(/}\s*{/g, "}\n{").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      return answers[answers.length - 1];
    };
    if (c.services !== "PAYOUT") {
      const made2 = runBlock("Create a pay-in order");
      assert.equal(made2.verified, true, JSON.stringify(made2));
      assert.equal(made2.flow, inUse(c), "the kit's order takes the merchant's flow");
    }
    if (c.services !== "PAYIN") {
      // The kit adds a test beneficiary and pays it 10.99, which the sandbox pays at once.
      const sent = runBlock("Payouts");
      assert.deepEqual([sent.payout?.status, sent.payout?.livemode], ["SUCCESS", false], JSON.stringify(sent));
    }

    // ── 5c. The support bot's lookups, on this banker's real data (no model call: the tools are
    //        what decide what the bot can see). Once, on a banker with both services.
    if (c.services === "BOTH" && c.flow === "P2P") {
      const ctx = { codes: [bankerCode], names: { [bankerCode]: `E2E Banker ${i}` } };
      const call = async (name: string, input: Record<string, unknown>, cx = ctx) => {
        const r = await runSupportTool(name, input, cx);
        assert.equal(r.isError, false, `${name}: ${r.text}`);
        assert.equal(/payu|razorpay|cashfree|ccavenue|rubyvault|ismartpay/i.test(r.text), false, `${name} names no gateway`);
        assert.ok(!r.text.includes(creds.salt), `${name} never carries the Salt`);
        return JSON.parse(r.text);
      };
      const setup = await call("get_account_setup", {});
      assert.deepEqual([setup.merchant_code, setup.services, setup.payin_flow, setup.test_key], [bankerCode, "BOTH", "P2P", creds.key]);
      // A request signed with the amount written differently: the bot must say exactly that.
      const bad = { txnid: `E2E-${RUN}-SIG`, amount: "25.00", productinfo: "e2e", email: "payer@katana.test" };
      const refused = await api("POST", "/api/v1/p2p/order", { key: creds.key, ...bad, hash: orderHash(creds, { ...bad, amount: "25" }) }, "");
      assert.equal(refused.status, 401);
      await new Promise((r) => setTimeout(r, 500));   // the log row is written after the answer
      const reqs = await call("list_recent_requests", { only_errors: true, limit: 5 });
      const row = reqs.requests.find((x: { sent?: { txnid?: string } }) => x.sent?.txnid === bad.txnid);
      assert.ok(row, "the refused request is in the log");
      assert.deepEqual([row.http_status, row.sent.key_mode, row.sent.amount], [401, "test", "25.00"]);
      const sig = await call("check_signature", { request_id: row.request_id });
      assert.deepEqual([sig.verdict, sig.should_sign], ["AMOUNT_FORMAT", `${bad.txnid}|25.00|e2e|payer@katana.test`]);
      const found = await call("find_order", { reference: general.body.order.order_id });
      assert.deepEqual([found.found, found.order.status, found.order.livemode], [true, "SUCCESS", false]);
      assert.ok(found.status_changes.some((x: { to: string }) => x.to === "SUCCESS"));
      // A payment traced from what a screenshot shows: the amount, and the UPI ID it was paid to.
      const paid = await call("find_payment", { utr: null, amount_rupees: Number(general.body.order.amount), paid_at: null, paid_to_upi_id: `e2e${i}@upi` });
      assert.ok(paid.orders.some((o: { txnid: string }) => o.txnid === general.body.order.order_id), JSON.stringify(paid));
      assert.equal(paid.upi_id_on_screenshot_is_one_of_this_merchants_upi_ids, true);
      assert.equal((await call("find_payment", { utr: null, amount_rupees: 1, paid_at: null, paid_to_upi_id: "someone-else@upi" })).upi_id_on_screenshot_is_one_of_this_merchants_upi_ids, false);
      const payouts = await call("list_recent_payouts", { limit: 10 });
      assert.ok(payouts.payouts.some((p: { status: string }) => p.status === "SUCCESS"));
      await call("list_webhook_deliveries", { limit: 5 });
      // Another banker's order and payment are not found from this banker's conversation.
      const other = await rows<{ order_id: string; rrn: string | null }>("vendorGateway",
        `SELECT order_id, rrn FROM vendor_payin_orders WHERE merchant_id <> $1 AND merchant_id IS NOT NULL ORDER BY rrn NULLS LAST LIMIT 1`, [bankerCode]);
      if (other[0]) {
        assert.equal((await call("find_order", { reference: other[0].order_id })).found, false);
        if (other[0].rrn) {
          const leak = await call("find_payment", { utr: other[0].rrn, amount_rupees: null, paid_at: null, paid_to_upi_id: null });
          assert.deepEqual([leak.orders.length, leak.money_received.length], [0, 0], "another banker's UTR finds nothing");
        }
      }
      // A merchant's scope with this banker reads it, and says which account each row is from.
      const many = await call("get_account_setup", {}, { codes: [bankerCode, "E2E-NOT-A-BANKER"], names: ctx.names });
      assert.equal(many.accounts_total, 2);
      assert.ok(many.accounts.some((a: { account: string }) => a.account === `E2E Banker ${i} (${bankerCode})`));
      const none = await runSupportTool("find_order", { reference: "anything" }, { codes: [] });
      assert.equal(none.isError, true, "no account in scope: no lookup runs");

      // The staff API: who to test as, and no model call without a key.
      const list = await api("GET", `/api/support-bot?scope=banker:${bankerCode}`);
      assert.equal(list.status, 200, JSON.stringify(list.body));
      assert.ok(list.body.bankers.some((b: { code: string }) => b.code === bankerCode));
      assert.ok(list.body.merchants.some((m: { id: string }) => m.id === providerId));
      if (!list.body.configured) {
        const ask = await api("POST", "/api/support-bot", { scope: `banker:${bankerCode}`, text: "Why was my order refused?" });
        assert.deepEqual([ask.status, ask.body.code], [503, "NOT_CONFIGURED"]);
      }
      // A screenshot that is not a picture is refused before any model call.
      const notImage = await api("POST", "/api/support-bot", { scope: `banker:${bankerCode}`, text: "look", images: [Buffer.from("%PDF-1.7 not a picture").toString("base64")] });
      assert.deepEqual([notImage.status, notImage.body.code], [400, "BAD_IMAGE"]);

      // The banker's and the merchant's own logins: their own scope only, never a staff test.
      const bankerLogin = await login(bankerEmail, made.body.branch.login.password);
      const providerEmail = `e2e-p-${RUN.toLowerCase()}-${i}@katana.test`;
      const pl = await api("POST", "/api/admin/set-password", { email: providerEmail, kind: "PROVIDER", scope_id: providerId, scope_label: `E2E ${c.name}` });
      assert.equal(pl.status, 200, JSON.stringify(pl.body));
      const providerLogin = await login(providerEmail, pl.body.password);
      const staffConvo = (await rows<{ id: string }>("merchant", `
        INSERT INTO support_bot_conversations (merchant_code, scope_key, channel, title, started_by)
        VALUES ($1, $2, 'STAFF', 'e2e staff test', 'e2e') RETURNING id::text`, [bankerCode, `banker:${bankerCode}`]))[0].id;
      const otherConvo = (await rows<{ id: string }>("merchant", `
        INSERT INTO support_bot_conversations (merchant_code, scope_key, channel, title, started_by)
        VALUES ('E2E-OTHER', 'banker:E2E-OTHER', 'PORTAL', 'e2e other banker', 'e2e') RETURNING id::text`))[0].id;
      // Home and payment search: their own bankers only, links into their own portal.
      for (const [who, cookie, base] of [["banker", bankerLogin, "/banker-portal"], ["merchant", providerLogin, "/merchant-portal"]] as const) {
        const home = await api("GET", "/api/portal/home", undefined, `${cookie}; katana_mode=test`);
        assert.equal(home.status, 200, `${who} home: ${JSON.stringify(home.body)}`);
        assert.equal(home.body.base, base);
        assert.ok(home.body.today.paid.count >= 1, `${who} sees today's paid test order`);
        for (const a of home.body.attention) assert.ok(!a.action || a.action.href.startsWith(base), `${who}: ${a.action?.href}`);
        const mine = await api("GET", `/api/portal/find?q=${encodeURIComponent(general.body.order.order_id)}`, undefined, cookie);
        assert.equal(mine.status, 200);
        const hit = mine.body.results.find((r: { txnid: string }) => r.txnid === general.body.order.order_id);
        assert.ok(hit, `${who} finds its own order`);
        assert.equal(hit.status.word, "Paid");
        assert.ok(hit.story.length >= 2 && !hit.story.join(" ").match(/payu|razorpay|rubyvault|VPA|RRN/i), hit.story.join(" | "));
        if (other[0]) assert.equal((await api("GET", `/api/portal/find?q=${encodeURIComponent(other[0].order_id)}`, undefined, cookie)).body.results
          .filter((r: { txnid: string }) => r.txnid === other[0].order_id).length, 0, `${who} does not find another banker's order`);
      }
      assert.equal((await api("GET", "/api/portal/home")).status, 403, "staff have their own dashboard");

      // Integration health: each login sees its own banker, with the test requests made above.
      for (const [who, cookie] of [["banker", bankerLogin], ["merchant", providerLogin]] as const) {
        const h = await api("GET", "/api/portal/integration-health", undefined, `${cookie}; katana_mode=test`);
        assert.equal(h.status, 200, `${who} health: ${JSON.stringify(h.body)}`);
        const mine = h.body.bankers.find((b: { code: string }) => b.code === bankerCode);
        assert.ok(mine, `${who} sees its banker's health`);
        assert.ok(mine.api.requests >= 1, `${who} sees the banker's API requests`);
        assert.deepEqual(h.body.bankers.map((b: { code: string }) => b.code), [bankerCode], `${who} sees only its own banker`);
      }
      // The merchant's Transactions page reads the same orders the banker's does, and the money feed answers.
      const mTxns = await api("GET", "/api/merchant-portal/transactions", undefined, `${providerLogin}; katana_mode=test`);
      assert.equal(mTxns.status, 200, JSON.stringify(mTxns.body));
      assert.ok(mTxns.body.recent.some((t: { ref: string }) => t.ref === general.body.order.order_id), "merchant sees its banker's order");
      assert.equal((await api("GET", "/api/merchant-portal/vpa-transactions", undefined, providerLogin)).status, 200);
      assert.equal((await api("GET", "/api/portal/integration-health")).status, 403, "staff have gateway health instead");

      // Key + Salt: in the merchant portal's main menu, and its card reads the merchant's own banker.
      // (Issuing is not repeated here: a new test pair would replace the one the steps below sign with.)
      const keysPage = await fetch(`${BASE}/merchant-portal/keys`, { redirect: "manual", headers: { cookie: providerLogin } });
      assert.equal(keysPage.status, 200, "merchant opens the Key + Salt page");
      const keyStatus = await api("GET", `/api/merchants/${bankerId}/checkout-key`, undefined, providerLogin);
      assert.equal(keyStatus.status, 200, JSON.stringify(keyStatus.body));
      assert.equal(keyStatus.body.test_status?.configured, true, "the merchant sees its banker's test pair");

      try {
        for (const [who, cookie] of [["banker", bankerLogin], ["merchant", providerLogin]] as const) {
          const mineList = await api("GET", "/api/support-bot", undefined, cookie);
          if (mineList.status === 403 && mineList.body?.code === "NOT_ENABLED") continue;   // SUPPORT_BOT_PORTALS off
          assert.equal(mineList.status, 200, `${who}: ${JSON.stringify(mineList.body)}`);
          assert.equal(mineList.body.staff, false);
          assert.equal(mineList.body.bankers, undefined, `${who} is not given the list of bankers`);
          assert.ok(mineList.body.accounts.some((a: { code: string }) => a.code === bankerCode), `${who} reads its own banker`);
          assert.ok(!mineList.body.conversations.some((x: { id: string }) => x.id === staffConvo || x.id === otherConvo), `${who} lists only its own`);
          for (const id of [staffConvo, otherConvo])
            assert.equal((await api("GET", `/api/support-bot/${id}`, undefined, cookie)).status, 404, `${who} cannot open ${id}`);
          // Naming another scope changes nothing: a portal user always asks as itself.
          const as = await api("POST", "/api/support-bot", { conversation_id: otherConvo, text: "hi" }, cookie);
          assert.equal(as.status, 404, `${who} cannot continue another banker's conversation`);
        }
      } finally {
        await rows("merchant", `DELETE FROM support_bot_conversations WHERE id = ANY($1::uuid[])`, [[staffConvo, otherConvo]]);
      }
    }

    // ── 6. The staff screens' data.
    const ready = await api("GET", "/api/merchant-readiness");
    const row = ready.body.merchants.find((m: { id: string }) => m.id === providerId);
    assert.deepEqual([row.services, row.flow.flow, row.bankers.length, row.bankers[0].stage], [c.services, c.flow ?? "UNSET", 1, "LIVE"]);
    const flows = await api("GET", "/api/payin-flows");
    const listed = flows.body.merchants.some((m: { id: string }) => m.id === providerId);
    assert.equal(listed, c.services !== "PAYOUT", "a pay-out only merchant is not on the Pay-in Flows list");
    if (c.services === "PAYOUT") assert.ok(flows.body.payout_only.merchants >= 1);

    // ── 7. The banker's own login: it is told its services and reaches no staff route.
    const bankerCookie = await login(bankerEmail, made.body.branch.login.password);
    const mine = await api("GET", "/api/me/integration", undefined, bankerCookie);
    assert.deepEqual([mine.status, mine.body.services], [200, c.services]);
    for (const [method, path, body] of [
      ["GET", "/api/merchant-readiness", undefined],
      ["PUT", `/api/providers/${providerId}/services`, { services: "BOTH" }],
      ["PUT", `/api/providers/${providerId}/onboarding-choice`, { services: "BOTH", payin_flow: "P2P" }],
      ["GET", `/api/providers/${providerId}/onboarding-choice`, undefined],
    ] as const) {
      const r = await api(method, path, body, bankerCookie);
      assert.ok(r.status === 401 || r.status === 403, `${method} ${path} as a banker: ${r.status}`);
    }
    assert.equal((await api("GET", `/api/providers/${providerId}/services`)).body.services, c.services, "and nothing was changed");
  });
}

test("changing a merchant's choice warns first, then takes effect on the next order", async (t) => {
  const why = skip(); if (why) return t.skip(why);
  // The P2P merchant of the matrix: its banker is live with a UPI ID and no gateway.
  const code = `${PROVIDER_PREFIX}${RUN}-0`, bankerCode = `${BANKER_PREFIX}${RUN}0`;
  const p = (await rows<{ id: string }>("provider", `SELECT id::text FROM providers WHERE code = $1`, [code]))[0];
  if (!p) return t.skip("the P2P merchant of the matrix was not created");
  const bankerId = (await rows<{ id: string }>("merchant", `SELECT id::text FROM merchants WHERE merchant_code = $1`, [bankerCode]))[0].id;
  const creds = (await api("POST", `/api/merchants/${bankerId}/checkout-key`, { livemode: false })).body.creds as Creds;

  // As saved, it is ready. Asked "what if Intent?", its live banker would not be.
  const now = await api("GET", `/api/providers/${p.id}/onboarding-choice`);
  assert.deepEqual([now.body.bankers[0].result === "FAIL", now.body.live_not_ready], [false, 0]);
  const whatIf = await api("GET", `/api/providers/${p.id}/onboarding-choice?flow=INTENT`);
  assert.deepEqual([whatIf.body.flow.flow, whatIf.body.bankers[0].result, whatIf.body.live_not_ready], ["INTENT", "FAIL", 1]);
  assert.equal((await api("GET", `/api/providers/${p.id}/payin-flow`)).body.flow, "P2P", "asking changes nothing");

  // An order taken while pay-ins were on…
  const open = await order(creds, "/api/v1/katana-pay/order");
  assert.equal(open.status, 201);

  // …an invalid change is refused, a valid one is saved with its history.
  assert.equal((await api("PUT", `/api/providers/${p.id}/onboarding-choice`, { services: "PAYIN" })).status, 400);
  assert.equal((await api("PUT", `/api/providers/${p.id}/onboarding-choice`, { services: "PAYOUT", payin_flow: "P2P" })).status, 400);
  const changed = await api("PUT", `/api/providers/${p.id}/onboarding-choice`, { services: "PAYOUT", note: "e2e: switched to pay-out only" });
  assert.deepEqual([changed.status, changed.body.services, changed.body.flow.flow], [200, "PAYOUT", "UNSET"]);
  const hist = await api("GET", `/api/providers/${p.id}/services`);
  assert.deepEqual([hist.body.history[0].from_services, hist.body.history[0].to_services], ["PAYIN", "PAYOUT"]);

  // New pay-ins are refused at once; the order already open is still there and can still be paid.
  assert.deepEqual((await order(creds, "/api/v1/katana-pay/order")).body.code, "PAYIN_NOT_ENABLED");
  const status = await fetch(`${BASE}/api/pay-status/${open.body.order.id}`).then((r) => r.json());
  assert.equal(status.status, "PENDING");

  // And back: pay-ins are taken again.
  const back = await api("PUT", `/api/providers/${p.id}/onboarding-choice`, { services: "BOTH", payin_flow: "P2P" });
  assert.deepEqual([back.status, back.body.services, back.body.flow.flow], [200, "BOTH", "P2P"]);
  assert.equal((await order(creds, "/api/v1/katana-pay/order")).status, 201);
});
