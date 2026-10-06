// PayAtom on real orders (lib/payin-providers/payatom, createKatanaOrder, lib/gateway-payin), against
// a stand-in for PayAtom's server on localhost: a banker whose PayAtom account is saved as P2P (the
// money lands in its own accounts) has its P2P orders taken by PayAtom and recorded as P2P with
// PayAtom as the rail; an Intent order never goes to that account; PayAtom's signed status answer
// confirms the order. Run with `pnpm test:integration`. IT WRITES ROWS, so it only runs against a
// local database; the banker's gateway account and its merchant's flow are put back as they were.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "http";
import { createHash } from "crypto";
import { rows } from "@/lib/pg";
import { createKatanaOrder, PayinFlowError } from "@/lib/katana-order";
import { PayinLimitError } from "@/lib/payin-limits";
import { setProviderFlow } from "@/lib/payin-flow-store";
import { getGatewayMid, storeGatewayMid, type GatewayMid } from "@/lib/gateway-creds";
import { checkGatewayPayin } from "@/lib/gateway-payin";
import { flowReadiness } from "@/lib/payin-flow-api";
import { payatomEncrypt } from "@/lib/payin-providers/payatom";

const HOST = process.env.PG_HOST ?? "localhost";
const LOCAL = ["localhost", "127.0.0.1", "::1"].includes(HOST);
const opts = { skip: LOCAL ? false : `refusing to write to a non-local database (${HOST})` };
const PROVIDER = process.env.TEST_PROVIDER_ID ?? "a0000000-0000-0000-0000-000000000001";
const A = process.env.TEST_BANKER ?? "M10001";
const BY = "integration-test-payatom@local";
const PREFIX = "ITEST-PA-";
const R = String(Date.now()).slice(-7);
let n = 0;
const ref = () => `${PREFIX}${R}-${n++}`;
const SECRET = "itest-payatom-secret";
const PAYEE = "banker-own@okicici";
const md5 = (s: string) => createHash("md5").update(s).digest("hex");

// Live PayAtom orders are switched on for this process only.
process.env.PAYIN_CONNECTORS_PROD = `${process.env.PAYIN_CONNECTORS_PROD ?? "PAYU"},PAYATOM`;

// ── The stand-in PayAtom ─────────────────────────────────────────────────────────────────────
const orders = new Map<string, { order_id: string; amount: number; status: string; bank_ref: string }>();
let server: Server;
let base = "";
function startPayatom(): Promise<void> {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const b = JSON.parse(raw || "{}");
      const send = (o: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      if (req.headers["x-api-key"] !== "itest-key") return send({ status: "error", message: "Invalid API key" });
      if (req.url === "/api/v2/request.php") {
        const code = `REF${orders.size + 1}`;
        orders.set(code, { order_id: b.order_id, amount: b.amount, status: "Pending", bank_ref: "" });
        return send({ status: "success", ref_code: code, qr_code: `upi://pay?pa=${PAYEE}&pn=Acme&am=${b.amount}&cu=INR&tr=${b.order_id}`, amount: b.amount, receiverVPA: PAYEE });
      }
      if (req.url === "/api/v2/status_polling.php") {
        const o = orders.get(b.ref_code);
        if (!o) return send({ status: "error", message: "Reference code not found." });
        const received = o.status === "Approved" ? o.amount : 0;
        return send({
          order_id: o.order_id, ref_code: b.ref_code, upi_id: PAYEE, requested_amount: o.amount, received_amount: received,
          bank_ref: o.bank_ref, sender_upi: "payer@upi", webhook_acknowledged: "0", status: o.status,
          post_hash: payatomEncrypt(md5(o.order_id + String(received) + o.status + SECRET), SECRET).toString("base64"),
        });
      }
      send({ status: "error", message: "unknown path" });
    });
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => {
    const a = server.address();
    base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
    ok();
  }));
}

// ── The banker's PayAtom account, put back afterwards ────────────────────────────────────────
let priorMid: GatewayMid | null = null;
const payatomMid = (channel: "P2P" | "INTENT"): GatewayMid => ({
  gateway: "PAYATOM", mid_code: "PID-ITEST", key: "PID-ITEST", salt: SECRET, scheme: "HMAC_SHA256" as GatewayMid["scheme"], env: "PROD",
  extra: { channel, api_key: "itest-key", api_base: base, latitude: "19.07", longitude: "72.87" },
});

before(async () => {
  if (!LOCAL) return;
  await startPayatom();
  priorMid = await getGatewayMid(A).catch(() => null);
  await storeGatewayMid(A, payatomMid("P2P"));
  await setProviderFlow(PROVIDER, { flow: "BOTH", active: "P2P", by: BY });
});
after(async () => {
  if (LOCAL) {
    if (priorMid) await storeGatewayMid(A, priorMid);
    else await rows("checkout", `DELETE FROM credential_vault WHERE kind = 'mid_secret' AND owner_type = 'merchant' AND owner_id = $1 AND label = 'gateway_mid'`, [A]);
    await rows("vendorGateway", `DELETE FROM vendor_payin_orders WHERE order_id LIKE '${PREFIX}%'`).catch(() => {});
    await setProviderFlow(PROVIDER, { flow: "UNSET", by: BY });
    await rows("provider", "DELETE FROM provider_payin_flow_history WHERE changed_by = $1", [BY]);
    await rows("provider", "UPDATE providers SET payin_flow_set_by = NULL, payin_flow_set_at = NULL WHERE payin_flow_set_by = $1", [BY]);
    server?.close();
  }
  setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
});

const stored = async (id: string) => (await rows<{ channel_type: string; channel_id: string; status: string; rrn: string | null; vendor_txn_id: string; meta: any }>("vendorGateway",
  `SELECT channel_type, channel_id, status, rrn, vendor_txn_id, meta FROM vendor_payin_orders WHERE id = $1::uuid`, [id]))[0];

test("a P2P order goes to the banker's P2P PayAtom account and is recorded as P2P via PayAtom", opts, async () => {
  const r = await createKatanaOrder({ orderId: ref(), amount: 250, currency: "INR", merchantId: A, livemode: true, flow: "P2P" });
  const s = await stored(r.order.id);
  assert.equal(s.channel_type, "P2P");
  assert.equal(s.channel_id, "PAYATOM");
  assert.equal(s.meta.gateway.provider, "PAYATOM");
  assert.equal(s.meta.gateway.payment_id, "REF1");          // PayAtom's ref_code, for status polling
  assert.equal(s.meta.receiver_vpa, PAYEE);
  assert.match(r.upiIntent, new RegExp(`pa=${PAYEE.replace(".", "\\.")}`));

  // PayAtom says Approved: its signed status answer confirms the order, with its UTR.
  const o = orders.get("REF1")!; o.status = "Approved"; o.bank_ref = "UTR-ITEST-1";
  const c = await checkGatewayPayin({ provider: "PAYATOM", txnid: s.vendor_txn_id, merchantCode: A, source: "webhook" });
  assert.equal(c.status, "SUCCESS", JSON.stringify(c));
  const after = await stored(r.order.id);
  assert.equal(after.status, "SUCCESS");
  assert.equal(after.rrn, "UTR-ITEST-1");
});

test("a live order under the payment account's minimum is refused before PayAtom is asked", opts, async () => {
  const seen = orders.size;
  await assert.rejects(
    createKatanaOrder({ orderId: ref(), amount: 7, currency: "INR", merchantId: A, livemode: true, flow: "P2P" }),
    (e: unknown) => e instanceof PayinLimitError && e.breach.code === "AMOUNT_BELOW_MIN" && e.breach.limit === 201
      && !/payatom/i.test(e.message),
  );
  assert.equal(orders.size, seen, "PayAtom was not asked");
});

test("an Intent order never goes to a P2P account: refused, the account is the wrong flow", opts, async () => {
  await assert.rejects(
    createKatanaOrder({ orderId: ref(), amount: 250, currency: "INR", merchantId: A, livemode: true, flow: "INTENT" }),
    (e: unknown) => e instanceof PayinFlowError && e.code === "FLOW_NOT_READY",
  );
});

test("readiness: a P2P PayAtom account makes the banker P2P-ready, not Intent-ready; as Intent, the reverse", opts, async () => {
  let r = (await flowReadiness([A])).get(A)!;
  assert.equal(r.intent, false);
  assert.equal(r.p2p, true);
  await storeGatewayMid(A, payatomMid("INTENT"));
  try {
    r = (await flowReadiness([A])).get(A)!;
    assert.equal(r.intent, true);
    // The same order on the Intent flow now goes to PayAtom as INTENT.
    const o = await createKatanaOrder({ orderId: ref(), amount: 250, currency: "INR", merchantId: A, livemode: true, flow: "INTENT" });
    const s = await stored(o.order.id);
    assert.equal(s.channel_type, "INTENT");
    assert.equal(s.channel_id, "PAYATOM");
  } finally {
    await storeGatewayMid(A, payatomMid("P2P"));
  }
});
