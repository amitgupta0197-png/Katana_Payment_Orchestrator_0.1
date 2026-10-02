// POST /api/admin/secrets/seal — encrypt the secrets still stored as plaintext (lib/sealed-text):
// merchant webhook secrets, mailbox app passwords and refresh tokens, TOTP secrets. Run once
// after deploying; safe to run again. Answers with counts only, never a secret.
import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { wormAppend } from "@/lib/worm";
import { sealPlaintextSecrets } from "@/lib/sealed-text";

export const dynamic = "force-dynamic";

export async function POST() {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  try {
    const result = await sealPlaintextSecrets();
    await wormAppend({
      actorId: g.session.user_id, actorEmail: g.session.email, action: "secrets.seal_plaintext",
      resourceType: "secrets", resourceId: "sealed-text", after: { result },
    }).catch(() => {});
    return NextResponse.json({ ok: true, result });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
