// POST /api/v1/device/enroll — a capture phone enrols its own signing key (agent v3.11+).
//
// Body: { device_id, install_id, public_key, hardware_backed? }; public_key is the base64
// X.509 SubjectPublicKeyInfo of an EC P-256 key made on the phone. The request is signed with
// that same key (x-timestamp, x-device-signature over "<device_id>.<timestamp>.<body>"), which
// proves the sender holds the private half. The rules for which key a device id may have are
// in lib/device-keys.ts.
//
// Enrolling a key does not make a phone trusted: a new device is still UNKNOWN until staff
// trust it, and only a TRUSTED device confirms an order by itself. What the key adds is that
// nobody else can then send as that phone.
//
// Public route (the signature is the authentication; whitelisted in middleware).

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { deviceSigningString } from "@/lib/device-auth";
import { enrolDeviceKey, verifyDeviceSignature } from "@/lib/device-keys";
import { recordSecurityEvent } from "@/lib/security-event";

export const dynamic = "force-dynamic";

const schema = z.object({
  device_id: z.string().min(1).max(120),
  install_id: z.string().max(64).optional(),
  public_key: z.string().min(80).max(400),
  hardware_backed: z.boolean().optional(),
});

const REPLAY_SKEW_MS = 5 * 60 * 1000;
// New keys an hour, across all phones. A real rollout enrols each phone once.
const MAX_NEW_PER_HOUR = Number(process.env.DEVICE_ENROL_MAX_PER_HOUR ?? 300);

export async function POST(req: Request) {
  const raw = await req.text();
  let body: z.infer<typeof schema>;
  try { body = schema.parse(JSON.parse(raw)); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }

  const ts = req.headers.get("x-timestamp") ?? "";
  const sig = req.headers.get("x-device-signature") ?? "";
  const tsMs = Number(ts) > 1e12 ? Number(ts) : Number(ts) * 1000;
  if (!ts || !sig || !Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > REPLAY_SKEW_MS)
    return NextResponse.json({ error: "missing or stale signature" }, { status: 401 });
  if (!verifyDeviceSignature(body.public_key, deviceSigningString(body.device_id, ts, raw), sig))
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });

  try {
    const recent = (await rows<{ n: number }>("vendorGateway",
      `SELECT count(*)::int AS n FROM vendor_device_keys WHERE enrolled_at > now() - interval '1 hour'`))[0]?.n ?? 0;
    if (recent >= MAX_NEW_PER_HOUR) {
      void recordSecurityEvent({ risk: "DEVICE_KEY", severity: "HIGH", detail: `More than ${MAX_NEW_PER_HOUR} device keys enrolled in an hour; further enrolments are refused until it passes.` });
      return NextResponse.json({ error: "too many enrolments; try again later" }, { status: 429 });
    }

    const r = await enrolDeviceKey({
      deviceId: body.device_id, installId: body.install_id ?? null,
      publicKey: body.public_key, hardwareBacked: body.hardware_backed ?? null,
    });
    if (!r.ok) {
      if (r.code !== "BAD_KEY")
        void recordSecurityEvent({
          risk: "DEVICE_KEY", severity: "HIGH",
          detail: `Device "${body.device_id}" tried to enrol a signing key and was refused: ${r.error}. If the agent was reinstalled on that phone, reset its key under Transaction intelligence → Devices.`,
        });
      return NextResponse.json({ error: r.error, code: r.code }, { status: r.code === "BAD_KEY" ? 400 : 409 });
    }
    return NextResponse.json({ ok: true, enrolled: r.enrolled });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
