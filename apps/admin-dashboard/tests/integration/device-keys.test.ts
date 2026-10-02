// A capture phone's own signing key, against a real database. Run with `pnpm test:integration`.
//
// IT WRITES ROWS, so it only runs against a local database and removes them. The key pairs are
// made here the way the agent makes them on the phone: EC P-256, the public half as X.509
// SubjectPublicKeyInfo, signatures as DER (Android's SHA256withECDSA).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { rows } from "@/lib/pg";
import { deviceSignature, deviceSigningString, verifyDeviceRequest } from "@/lib/device-auth";
import { enrolDeviceKey, resetDeviceKey } from "@/lib/device-keys";
import { POST as enrolPost } from "@/app/api/v1/device/enroll/route";

const HOST = process.env.PG_HOST ?? "localhost";
const LOCAL = ["localhost", "127.0.0.1", "::1"].includes(HOST);
const opts = { skip: LOCAL ? false : `refusing to write to a non-local database (${HOST})` };
const RUN = Date.now();
const dev = (n: string) => `itest-key-${n}-${RUN}`;

async function cleanup() {
  await rows("vendorGateway", "DELETE FROM vendor_device_keys WHERE device_id LIKE 'itest-key-%'");
  await rows("vendorGateway", "DELETE FROM vendor_devices WHERE device_id LIKE 'itest-key-%'");
  await rows("vendorGateway", "DELETE FROM vendor_security_alerts WHERE detail LIKE '%itest-key-%'");
}
before(async () => { if (LOCAL) await cleanup(); });
after(async () => { if (LOCAL) await cleanup(); setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref(); });

function phone() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { privateKey, publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64") };
}
const now = () => String(Math.floor(Date.now() / 1000));
const ownSig = (key: KeyObject, deviceId: string, ts: string, payload: string) =>
  sign("sha256", Buffer.from(deviceSigningString(deviceId, ts, payload)), key).toString("base64");

function ownRequest(key: KeyObject, deviceId: string, payload: string, over: Record<string, string> = {}) {
  const ts = over["x-timestamp"] ?? now();
  return new Request("http://test/api/v1/txn-alert", { method: "POST", headers: {
    "x-timestamp": ts, "x-device-id": encodeURIComponent(deviceId), "x-device-signature": ownSig(key, deviceId, ts, payload), ...over,
  } });
}
function sharedRequest(payload: string) {
  const ts = now();
  return new Request("http://test/api/v1/txn-alert", { method: "POST", headers: { "x-timestamp": ts, "x-signature": deviceSignature(ts, payload) } });
}

test("a phone with an enrolled key is recognised by it, and nobody else is", opts, async () => {
  const id = dev("a"), p = phone(), other = phone();
  assert.deepEqual(await enrolDeviceKey({ deviceId: id, installId: "inst-a", publicKey: p.publicKey }), { ok: true, enrolled: "new" });
  const body = JSON.stringify({ device_id: id, amount: 10 });

  assert.deepEqual(await verifyDeviceRequest(ownRequest(p.privateKey, id, body), body), { ok: true, deviceId: id, keyed: true });
  // Another key, a changed body, a stale timestamp, and a body naming a different phone: all refused.
  assert.equal((await verifyDeviceRequest(ownRequest(other.privateKey, id, body), body)).ok, false);
  assert.equal((await verifyDeviceRequest(ownRequest(p.privateKey, id, body), body.replace("10", "99"))).ok, false);
  assert.equal((await verifyDeviceRequest(ownRequest(p.privateKey, id, body, { "x-timestamp": String(Math.floor(Date.now() / 1000) - 3600) }), body)).ok, false);
  const forB = JSON.stringify({ device_id: dev("b"), amount: 10 });
  assert.equal((await verifyDeviceRequest(ownRequest(p.privateKey, id, forB), forB)).ok, false);
});

test("a device id with a space and an emoji in it survives the header", opts, async () => {
  const id = `itest-key-author 😎-${RUN}`, p = phone();
  assert.equal((await enrolDeviceKey({ deviceId: id, installId: null, publicKey: p.publicKey })).ok, true);
  const body = JSON.stringify({ device_id: id });
  assert.deepEqual(await verifyDeviceRequest(ownRequest(p.privateKey, id, body), body), { ok: true, deviceId: id, keyed: true });
});

test("the shared key no longer works for a phone that has its own, and still works for one that has not", opts, async () => {
  const keyed = dev("a"), old = dev("old");
  const forKeyed = JSON.stringify({ device_id: keyed, amount: 10 });
  const r = await verifyDeviceRequest(sharedRequest(forKeyed), forKeyed);
  assert.deepEqual(r, { ok: false, error: "this device signs with its own key" });
  const forOld = JSON.stringify({ device_id: old, amount: 10 });
  assert.deepEqual(await verifyDeviceRequest(sharedRequest(forOld), forOld), { ok: true, deviceId: old, keyed: false });
  // The capture-rrn poll signs its query string.
  const q = `?device_id=${keyed}&merchant_id=M`;
  assert.equal((await verifyDeviceRequest(sharedRequest(q), q)).ok, false);

  // Switched off, the shared key works for nobody; a phone's own key is unaffected.
  process.env.AGENT_SHARED_KEY_ACCEPTED = "0";
  try {
    assert.equal((await verifyDeviceRequest(sharedRequest(forOld), forOld)).ok, false);
  } finally { delete process.env.AGENT_SHARED_KEY_ACCEPTED; }
});

test("a device id keeps the first key it enrolled until staff reset it", opts, async () => {
  const id = dev("c"), first = phone(), second = phone();
  assert.equal((await enrolDeviceKey({ deviceId: id, installId: null, publicKey: first.publicKey })).ok, true);
  assert.deepEqual(await enrolDeviceKey({ deviceId: id, installId: null, publicKey: first.publicKey }), { ok: true, enrolled: "same" });
  const again = await enrolDeviceKey({ deviceId: id, installId: null, publicKey: second.publicKey });
  assert.equal(again.ok === false && again.code, "KEY_CONFLICT");
  assert.equal(await resetDeviceKey(id), true);
  assert.deepEqual(await enrolDeviceKey({ deviceId: id, installId: null, publicKey: second.publicKey }), { ok: true, enrolled: "new" });
  const bad = await enrolDeviceKey({ deviceId: dev("d"), installId: null, publicKey: Buffer.from("not a key").toString("base64") });
  assert.equal(bad.ok === false && bad.code, "BAD_KEY");
});

test("a known phone's name is not enough to enrol as it: the install id must match", opts, async () => {
  const id = dev("known");
  await rows("vendorGateway", "INSERT INTO vendor_devices (device_id, status, install_id) VALUES ($1, 'TRUSTED', 'real-install')", [id]);
  const wrong = await enrolDeviceKey({ deviceId: id, installId: "someone-else", publicKey: phone().publicKey });
  assert.equal(wrong.ok === false && wrong.code, "INSTALL_MISMATCH");
  const none = await enrolDeviceKey({ deviceId: id, installId: null, publicKey: phone().publicKey });
  assert.equal(none.ok === false && none.code, "INSTALL_MISMATCH");
  assert.equal((await enrolDeviceKey({ deviceId: id, installId: "real-install", publicKey: phone().publicKey })).ok, true);
});

test("the enrol route wants the request signed by the key being enrolled", opts, async () => {
  const id = dev("route"), p = phone(), other = phone();
  const raw = JSON.stringify({ device_id: id, install_id: "inst-r", public_key: p.publicKey, hardware_backed: true });
  const call = (key: KeyObject) => {
    const ts = now();
    return enrolPost(new Request("http://test/api/v1/device/enroll", { method: "POST", body: raw,
      headers: { "x-timestamp": ts, "x-device-signature": ownSig(key, id, ts, raw) } }));
  };
  assert.equal((await call(other.privateKey)).status, 401);
  const ok = await call(p.privateKey);
  assert.deepEqual([ok.status, await ok.json()], [200, { ok: true, enrolled: "new" }]);
  assert.deepEqual(await (await call(p.privateKey)).json(), { ok: true, enrolled: "same" });
});
