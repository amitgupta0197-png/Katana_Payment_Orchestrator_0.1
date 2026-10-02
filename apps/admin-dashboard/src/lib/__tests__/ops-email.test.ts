// Mail to the operations team (lib/ops-email): what it needs to be switched on, what goes on the
// wire, and a whole conversation with an SMTP server that lives only for the test.

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { buildMessage, sendOpsEmail, smtpConfig, type SmtpConfig } from "@/lib/ops-email";

test("mail is off until a recipient, a server and a sender are set", () => {
  assert.equal(smtpConfig({}), null);
  assert.equal(smtpConfig({ OPS_EMAIL_TO: "ops@example.com" }), null);
  assert.equal(smtpConfig({ OPS_EMAIL_TO: "not-an-address", SMTP_HOST: "smtp.example.com", SMTP_USER: "a@example.com" }), null);
  const c = smtpConfig({ OPS_EMAIL_TO: "ops@example.com, lead@example.com", SMTP_HOST: "smtp.example.com", SMTP_USER: "alerts@example.com", SMTP_PASSWORD: "x" });
  assert.deepEqual([c?.to, c?.port, c?.secure, c?.from], [["ops@example.com", "lead@example.com"], 465, "tls", "alerts@example.com"]);
  assert.equal(smtpConfig({ OPS_EMAIL_TO: "ops@example.com", SMTP_HOST: "h", SMTP_FROM: "f@example.com", SMTP_SECURE: "starttls" })?.port, 587);
});

test("a subject or address cannot add a header, and a line starting with a dot is kept", () => {
  const m = buildMessage({ from: "a@example.com", to: ["ops@example.com"] }, "PAYU down\r\nBcc: thief@example.com", "first\n.hidden\nlast");
  const [head, body] = m.split("\r\n\r\n");
  assert.equal(head.split("\r\n").some((l) => l.startsWith("Bcc:")), false);
  assert.equal(head.split("\r\n").filter((l) => l.startsWith("Subject:")).length, 1);
  assert.equal(body, "first\r\n..hidden\r\nlast");
});

/** An SMTP server that accepts one message and remembers what it was told. */
function fakeSmtp(opts: { rejectAuth?: boolean } = {}) {
  const seen: string[] = [];
  let data = "";
  const server = net.createServer((s) => {
    let inData = false, buf = "";
    s.write("220 test ESMTP\r\n");
    s.on("data", (d) => {
      buf += d.toString();
      if (inData) {
        if (buf.includes("\r\n.\r\n")) { data = buf.slice(0, buf.indexOf("\r\n.\r\n")); buf = ""; inData = false; s.write("250 queued\r\n"); }
        return;
      }
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2); seen.push(line);
        if (line.startsWith("EHLO")) s.write("250-test\r\n250 AUTH LOGIN\r\n");
        else if (line === "AUTH LOGIN") s.write("334 VXNlcm5hbWU6\r\n");
        else if (seen[seen.length - 2] === "AUTH LOGIN") s.write("334 UGFzc3dvcmQ6\r\n");
        else if (seen[seen.length - 3] === "AUTH LOGIN") s.write(opts.rejectAuth ? "535 bad credentials\r\n" : "235 ok\r\n");
        else if (line.startsWith("MAIL FROM") || line.startsWith("RCPT TO")) s.write("250 ok\r\n");
        else if (line === "DATA") { inData = true; s.write("354 go\r\n"); }
        else if (line === "QUIT") { s.write("221 bye\r\n"); s.end(); }
      }
    });
    s.on("error", () => {});
  });
  return {
    seen, message: () => data,
    listen: () => new Promise<number>((res) => server.listen(0, "127.0.0.1", () => res((server.address() as net.AddressInfo).port))),
    close: () => new Promise<void>((res) => server.close(() => res())),
  };
}
const cfg = (port: number): SmtpConfig => ({ host: "127.0.0.1", port, secure: "none", user: "alerts@example.com", password: "s3cret", from: "alerts@example.com", to: ["ops@example.com", "lead@example.com"] });

test("an alert is mailed to every recipient, signed in, with its subject and text", async () => {
  const smtp = fakeSmtp();
  const port = await smtp.listen();
  try {
    assert.equal(await sendOpsEmail("[Katana CRITICAL] PAYU: no webhook in the past 24 hours", "12 live orders and no webhook.\nCheck the webhook URL.", cfg(port)), true);
    assert.deepEqual(smtp.seen.filter((l) => /^(MAIL|RCPT)/.test(l)), ["MAIL FROM:<alerts@example.com>", "RCPT TO:<ops@example.com>", "RCPT TO:<lead@example.com>"]);
    assert.ok(smtp.seen.includes(Buffer.from("s3cret").toString("base64")));
    const m = smtp.message();
    assert.ok(m.includes("To: ops@example.com, lead@example.com"));
    assert.ok(m.includes(`Subject: =?UTF-8?B?${Buffer.from("[Katana CRITICAL] PAYU: no webhook in the past 24 hours").toString("base64")}?=`));
    assert.ok(m.endsWith("12 live orders and no webhook.\r\nCheck the webhook URL."));
  } finally { await smtp.close(); }
});

test("a server that refuses the sign-in, or is not there, is a failed send and not an exception", async () => {
  const smtp = fakeSmtp({ rejectAuth: true });
  const port = await smtp.listen();
  try { assert.equal(await sendOpsEmail("s", "t", cfg(port)), false); } finally { await smtp.close(); }
  assert.equal(await sendOpsEmail("s", "t", cfg(port)), false);   // nothing is listening there now
  assert.equal(await sendOpsEmail("s", "t", null), false);        // not configured
});
