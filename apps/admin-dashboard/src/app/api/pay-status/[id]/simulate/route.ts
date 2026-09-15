// POST /api/pay-status/[id]/simulate { outcome: "SUCCESS" | "FAILED" } — the Simulate success /
// Simulate failure buttons on a TEST order's payment page (test mode, phase 3).
//
// PUBLIC, like the page itself: the order id in the URL is the capability (middleware
// PUBLIC_API_PREFIX = /api/pay-status). Safe to leave open because it can only ever touch a TEST
// order — one that pays a sandbox UPI ID and moves no money — and only once: a pending test order
// becomes SUCCESS or FAILED, and the final-status lock refuses everything after that.
//
// It confirms through confirmPoolPayOrder exactly as a real payment does, so the merchant's status
// callback fires (signed with the test Salt, carrying LIVEMODE=false) and their integration can be
// tested end to end.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { genRrn, POOLPAY_TERMINAL } from "@/lib/poolpay";
import { confirmPoolPayOrder } from "@/lib/poolpay-order";

export const dynamic = "force-dynamic";

const schema = z.object({ outcome: z.enum(["SUCCESS", "FAILED"]) });

// A light per-IP brake for a public endpoint. In-process, like the session epoch cache: the
// dashboard runs as one instance. The order state is the real limit — one decision per order.
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;
const hits = new Map<string, { n: number; since: number }>();

function limited(ip: string): boolean {
  const now = Date.now();
  if (hits.size > 5_000) {
    for (const [k, v] of hits) if (now - v.since > WINDOW_MS) hits.delete(k);
  }
  const h = hits.get(ip);
  if (!h || now - h.since > WINDOW_MS) { hits.set(ip, { n: 1, since: now }); return false; }
  h.n += 1;
  return h.n > MAX_PER_WINDOW;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  if (limited(ip)) return NextResponse.json({ error: "too many attempts — try again in a minute" }, { status: 429 });

  let body;
  try { body = schema.parse(await req.json()); } catch {
    return NextResponse.json({ error: "outcome must be SUCCESS or FAILED" }, { status: 400 });
  }

  try {
    const found = await rows<{ id: string; status: string; livemode: boolean }>("vendorGateway",
      `SELECT id::text, status, livemode FROM vendor_payin_orders WHERE id = $1::uuid AND vendor = 'POOLPAY'`, [id]);
    if (!found.length) return NextResponse.json({ error: "not found" }, { status: 404 });
    const order = found[0];
    // The whole safety of a public endpoint rests on this line: a live order is never simulated.
    if (order.livemode !== false)
      return NextResponse.json({ error: "only test orders can be simulated" }, { status: 403 });
    if (POOLPAY_TERMINAL.has(order.status))
      return NextResponse.json({ error: `order already ${order.status}` }, { status: 409 });

    const r = await confirmPoolPayOrder({
      id: order.id,
      livemode: false,
      outcome: body.outcome,
      utr: body.outcome === "SUCCESS" ? genRrn(order.id) : null,
      evidence: "WEBHOOK",
      actor: "pay-page:simulated",
      note: `Simulated ${body.outcome === "SUCCESS" ? "success" : "failure"} from the test payment page`,
    });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ ok: true, simulated: true, order: r.order });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
