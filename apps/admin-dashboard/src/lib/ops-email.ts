// Email to the operations team, for the alerts that ask for one (lib/ops-alert, `email: true`).
//
// Katana had no way to send mail. This is the smallest one that works with any provider: plain
// SMTP over Node's own sockets, with no new dependency to install on the server. It is INERT
// until it is configured, and an alert is raised on Telegram whether or not mail is set up.
//
//   OPS_EMAIL_TO     who is told; one address or several, comma-separated
//   SMTP_HOST        the provider's SMTP server
//   SMTP_PORT        465 (default)
//   SMTP_SECURE      tls (default: TLS from the first byte, port 465) | starttls (port 587) | none (tests only)
//   SMTP_USER / SMTP_PASSWORD   the account to sign in with (AUTH LOGIN); leave both unset for a relay that needs none
//   SMTP_FROM        the From address; defaults to SMTP_USER
//
// Best-effort and never throws: an alert that cannot be mailed must not break the check that
// raised it. Only Katana staff are ever written to, so a message may name a gateway.

import net from "node:net";
import tls from "node:tls";

export interface SmtpConfig {
  host: string; port: number; secure: "tls" | "starttls" | "none";
  user: string | null; password: string | null; from: string; to: string[];
}

export function smtpConfig(env: Record<string, string | undefined> = process.env): SmtpConfig | null {
  const to = (env.OPS_EMAIL_TO ?? "").split(",").map((s) => s.trim()).filter((s) => /^[^\s@<>]+@[^\s@<>]+$/.test(s));
  const host = env.SMTP_HOST?.trim();
  const from = (env.SMTP_FROM ?? env.SMTP_USER ?? "").trim();
  if (!to.length || !host || !from) return null;
  const secure = env.SMTP_SECURE === "starttls" || env.SMTP_SECURE === "none" ? env.SMTP_SECURE : "tls";
  return {
    host, port: Number(env.SMTP_PORT ?? (secure === "starttls" ? 587 : 465)), secure,
    user: env.SMTP_USER?.trim() || null, password: env.SMTP_PASSWORD ?? null, from, to,
  };
}

export function opsEmailConfigured(): boolean {
  return smtpConfig() !== null;
}

// A header value on one line: nothing a subject or address contains can start a new header.
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

/** The message as it goes on the wire: headers, a blank line, the text, dots at line starts doubled. */
export function buildMessage(c: Pick<SmtpConfig, "from" | "to">, subject: string, text: string, now = new Date()): string {
  const body = text.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
  return [
    `From: Katana alerts <${oneLine(c.from)}>`,
    `To: ${c.to.map(oneLine).join(", ")}`,
    `Subject: =?UTF-8?B?${Buffer.from(oneLine(subject), "utf8").toString("base64")}?=`,
    `Date: ${now.toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "", body,
  ].join("\r\n");
}

type Sock = net.Socket | tls.TLSSocket;

/** Reads one SMTP reply (which may run over several lines) and resolves with its code. */
function reader(sock: Sock) {
  let buf = "";
  const waiting: ((r: { code: number; text: string }) => void)[] = [];
  const pump = () => {
    for (;;) {
      const lines = buf.split("\r\n");
      // A reply ends at the first line whose 4th character is a space ("250 ok", not "250-…").
      const end = lines.findIndex((l, i) => i < lines.length - 1 && /^\d{3} /.test(l));
      if (end < 0 || !waiting.length) return;
      const reply = lines.slice(0, end + 1);
      buf = lines.slice(end + 1).join("\r\n");
      waiting.shift()!({ code: Number(reply[end].slice(0, 3)), text: reply.join(" ") });
    }
  };
  const onData = (d: Buffer) => { buf += d.toString("utf8"); pump(); };
  sock.on("data", onData);
  return {
    next: () => new Promise<{ code: number; text: string }>((res) => { waiting.push(res); pump(); }),
    detach: () => sock.off("data", onData),
  };
}

async function talk(c: SmtpConfig, subject: string, text: string): Promise<void> {
  let sock: Sock = c.secure === "tls"
    ? tls.connect({ host: c.host, port: c.port, servername: c.host })
    : net.connect({ host: c.host, port: c.port });
  sock.setTimeout(10_000, () => sock.destroy(new Error("SMTP timed out")));
  const failed = new Promise<never>((_, rej) => sock.once("error", rej));
  let r = reader(sock);
  const expect = async (want: number, what: string) => {
    const got = await Promise.race([r.next(), failed]);
    if (Math.floor(got.code / 100) !== Math.floor(want / 100)) throw new Error(`SMTP ${what}: ${got.text.slice(0, 160)}`);
  };
  const say = async (line: string, want: number, what: string) => { sock.write(line + "\r\n"); await expect(want, what); };
  try {
    await expect(220, "greeting");
    await say("EHLO katanapay.co", 250, "EHLO");
    if (c.secure === "starttls") {
      await say("STARTTLS", 220, "STARTTLS");
      r.detach();
      const upgraded = tls.connect({ socket: sock, servername: c.host });
      upgraded.once("error", () => {});
      await new Promise<void>((res, rej) => { upgraded.once("secureConnect", res); upgraded.once("error", rej); });
      sock = upgraded;
      r = reader(sock);
      await say("EHLO katanapay.co", 250, "EHLO");
    }
    if (c.user && c.password != null) {
      await say("AUTH LOGIN", 334, "AUTH");
      await say(Buffer.from(c.user).toString("base64"), 334, "AUTH user");
      await say(Buffer.from(c.password).toString("base64"), 235, "AUTH password");
    }
    await say(`MAIL FROM:<${oneLine(c.from)}>`, 250, "MAIL FROM");
    for (const to of c.to) await say(`RCPT TO:<${oneLine(to)}>`, 250, "RCPT TO");
    await say("DATA", 354, "DATA");
    await say(buildMessage(c, subject, text) + "\r\n.", 250, "message");
    sock.write("QUIT\r\n");
  } finally {
    sock.end();
  }
}

/** Mail the operations team. False when mail is not configured or the send failed. */
export async function sendOpsEmail(subject: string, text: string, config: SmtpConfig | null = smtpConfig()): Promise<boolean> {
  if (!config) return false;
  try { await talk(config, subject, text); return true; }
  catch (err) { console.warn("[ops-email] not sent:", (err as Error).message); return false; }
}
