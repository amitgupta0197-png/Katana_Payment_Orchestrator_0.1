// The facts behind "Needs attention" (lib/attention). Each source is read with the function or
// table the rest of the dashboard already uses for it; nothing here creates an order, asks a
// gateway or sends a callback. A source that fails is skipped (the page shows the others), never
// turned into a false alarm. STAFF ONLY.
//
// The list is worked out on request and kept for CACHE_MS, so a room of staff with the page open
// does not run the banker check for every live banker on every refresh.

import { rows } from "@/lib/pg";
import { checkBankerById } from "@/lib/banker-check-store";
import { defaultOrderFlow } from "@/lib/banker-check";
import { listGoLive } from "@/lib/gateway-golive";
import { orderExpirySeconds } from "@/lib/katana-pay";
import { plainRefusal } from "@/lib/plain-errors";
import {
  attentionView, bankerHref, REFUSALS_MIN, VERIFYING_HOURS,
  type AttentionItem, type AttentionView,
} from "@/lib/attention";

const CACHE_MS = 60_000;
let cache: { at: number; items: AttentionItem[] } | null = null;

const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

interface Banker { id: string; code: string; stage: string; merchantName: string | null }

/** Every banker with its id, stage and the name of the merchant it is mapped under. */
async function bankers(): Promise<Map<string, Banker>> {
  const [ms, maps, provs] = await Promise.all([
    rows<{ id: string; code: string; stage: string | null }>("merchant",
      `SELECT id::text, merchant_code AS code, stage FROM merchants`),
    rows<{ merchant_id: string; provider_id: string }>("provider",
      `SELECT merchant_id::text, provider_id::text FROM provider_merchant_mappings WHERE status = 'ACTIVE'`).catch(() => []),
    rows<{ id: string; name: string }>("provider",
      `SELECT id::text, COALESCE(NULLIF(legal_name, ''), code) AS name FROM providers`).catch(() => []),
  ]);
  const provName = new Map(provs.map((p) => [p.id, p.name]));
  const providerOf = new Map(maps.map((m) => [m.merchant_id, m.provider_id]));
  const out = new Map<string, Banker>();
  for (const m of ms) {
    const pid = providerOf.get(m.id) ?? providerOf.get(m.code);
    out.set(m.code, { id: m.id, code: m.code, stage: m.stage ?? "", merchantName: pid ? provName.get(pid) ?? null : null });
  }
  return out;
}

async function gather(): Promise<AttentionItem[]> {
  const bk = await bankers();
  const who = (code: string) => {
    const b = bk.get(code);
    return { bankerCode: code, bankerId: b?.id ?? null, merchantName: b?.merchantName ?? null };
  };
  const items: AttentionItem[] = [];
  const add = (list: AttentionItem[]) => { items.push(...list); };

  await Promise.all([
    // Live bankers whose next live order would be refused, and P2P bankers whose phone is offline.
    (async () => {
      const live = [...bk.values()].filter((b) => b.stage === "LIVE");
      const p2pActive = new Set((await rows<{ code: string }>("vendorGateway", `
        SELECT DISTINCT merchant_id AS code FROM vendor_payin_orders
         WHERE livemode AND channel_type = 'P2P' AND created_at > now() - interval '7 days'`).catch(() => [])).map((r) => r.code));
      const out: AttentionItem[] = [];
      for (let i = 0; i < live.length; i += 6) {
        const batch = await Promise.all(live.slice(i, i + 6).map((b) => checkBankerById(b.id).catch(() => null)));
        batch.forEach((c, j) => {
          const b = live[i + j];
          if (!c) return;
          const f = c.facts;
          if (f.blocked || f.stageClosed || f.providerClosed) return;   // switched off on purpose
          const first = c.result.blockers[0];
          if (first) out.push({
            key: `REFUSES_LIVE:${b.code}:${first.key}`, category: "REFUSES_LIVE", ...who(b.code),
            title: `${b.code} would refuse a live order`,
            detail: `${first.title}. ${first.detail}`,
            since: null, count: c.result.blockers.length,
            fix: first.fix ? { label: first.fix.label, href: first.fix.href ?? bankerHref(b.id, b.code, first.fix.tab) } : { label: "Check this banker", href: bankerHref(b.id, b.code) },
          });
          const onP2p = defaultOrderFlow(f.flow) === "P2P" || (f.flow.flow === "UNSET" && !!f.upiId && f.account?.channel !== "INTENT");
          if (onP2p && p2pActive.has(b.code) && f.phones.online === 0) out.push({
            key: `PHONE_OFFLINE:${b.code}`, category: "PHONE_OFFLINE", ...who(b.code),
            title: `${b.code}'s payment phone is offline`,
            detail: f.phones.enrolled === 0 ? "No phone is set up to read this banker's payments." : "No phone has checked in for over 10 minutes.",
            since: f.phones.lastHeartbeat, count: 1,
            fix: { label: "Open the phone settings", href: bankerHref(b.id, b.code, "p2p") },
          });
        });
      }
      add(out);
    })().catch(() => {}),

    // Payment messages the merchant's server never took: a paid order first, then the rest.
    (async () => {
      const r = await rows<{ code: string; ord: string | null; st: string | null; status: string; at: string; attempts: number; err: string | null }>("notification", `
        SELECT o.merchant_id AS code, COALESCE(o.payload->>'ORDER_ID', o.payload->>'reference', o.payload->>'order_id') AS ord,
               COALESCE(o.payload->>'STATUS', o.payload->>'status') AS st, o.status, o.created_at::text AS at, o.attempts,
               o.last_error AS err
          FROM webhook_outbox o
         WHERE o.livemode AND NOT COALESCE(o.is_test, false) AND o.created_at > now() - interval '7 days'
           AND (o.status = 'DEAD_LETTER' OR (o.status = 'PENDING' AND o.attempts >= 3))
           AND NOT EXISTS (SELECT 1 FROM webhook_outbox d
                            WHERE d.order_id IS NOT DISTINCT FROM o.order_id AND d.merchant_id = o.merchant_id
                              AND d.status = 'DELIVERED' AND d.created_at > o.created_at
                              AND COALESCE(d.payload->>'STATUS', d.payload->>'status') IS NOT DISTINCT FROM COALESCE(o.payload->>'STATUS', o.payload->>'status'))
         ORDER BY o.created_at`).catch(() => []);
      const paid = (s: string | null) => s === "Captured" || s === "SUCCESS";
      const failing = new Map<string, { n: number; since: string; err: string | null }>();
      for (const x of r) {
        if (paid(x.st)) {
          items.push({
            key: `PAID_NOT_TOLD:${x.code}:${x.ord ?? x.at}`, category: "PAID_NOT_TOLD", ...who(x.code),
            title: `Order ${x.ord ?? "(no reference)"} was paid, but ${x.code}'s server was not told`,
            detail: `The success message failed ${x.attempts} time${x.attempts === 1 ? "" : "s"}${x.err ? ` (${x.err.slice(0, 80)})` : ""}. Tell the merchant it is paid, or resend it once their server answers.`,
            since: x.at, count: 1,
            fix: { label: "Open payment messages", href: bankerHref(who(x.code).bankerId, x.code, "integration") },
          });
        } else {
          const f = failing.get(x.code) ?? { n: 0, since: x.at, err: x.err };
          f.n++; f.err = x.err ?? f.err;
          failing.set(x.code, f);
        }
      }
      for (const [code, f] of failing) items.push({
        key: `CALLBACK_FAILING:${code}`, category: "CALLBACK_FAILING", ...who(code),
        title: `${f.n} payment message${f.n === 1 ? "" : "s"} to ${code}'s server failed`,
        detail: `In the last 7 days.${f.err ? ` Last error: ${f.err.slice(0, 100)}.` : ""} Their server is down or refusing them.`,
        since: f.since, count: f.n,
        fix: { label: "Open payment messages", href: bankerHref(who(code).bankerId, code, "integration") },
      });
    })().catch(() => {}),

    // Refusals by code in the last 24 hours: wrong gateway keys always; any other code when frequent.
    (async () => {
      const r = await rows<{ code: string; err: string; n: number; since: string }>("audit", `
        SELECT merchant_id AS code, error_code AS err, COUNT(*)::int AS n, MIN(created_at)::text AS since
          FROM api_request_log
         WHERE created_at > now() - interval '24 hours' AND livemode AND http_status >= 400
           AND error_code IS NOT NULL AND merchant_id IS NOT NULL
         GROUP BY 1, 2`).catch(() => []);
      for (const x of r) {
        if (x.err === "GATEWAY_CREDENTIALS") {
          items.push({
            key: `WRONG_CREDENTIALS:${x.code}`, category: "WRONG_CREDENTIALS", ...who(x.code),
            title: `${x.code}'s gateway keys look wrong`,
            detail: `${x.n} live order${x.n === 1 ? "" : "s"} failed in 24 hours because the gateway did not accept the saved keys. Ask the banker for the right live keys.`,
            since: x.since, count: x.n,
            fix: { label: "Save the keys again", href: bankerHref(who(x.code).bankerId, x.code, "intent") },
          });
        } else if (x.n >= REFUSALS_MIN) {
          const p = plainRefusal(x.err);
          items.push({
            key: `REFUSALS:${x.code}:${x.err}`, category: "REFUSALS", ...who(x.code),
            title: `${x.n} live orders from ${x.code} refused: ${p.text}`,
            detail: `${x.err} in the last 24 hours.${p.merchantSide ? " The merchant has to change something in their request." : ""}`,
            since: x.since, count: x.n,
            fix: p.fix ? { label: p.fix.label, href: p.fix.href ?? bankerHref(who(x.code).bankerId, x.code, p.fix.tab) } : { label: "See refused orders", href: bankerHref(who(x.code).bankerId, x.code) },
          });
        }
      }
    })().catch(() => {}),

    // Money that arrived with no order it could be matched to.
    (async () => {
      const r = await rows<{ code: string; n: number; total: string; since: string }>("vendorGateway", `
        SELECT merchant_id AS code, COUNT(*)::int AS n, SUM(amount)::text AS total, MIN(event_time)::text AS since
          FROM vendor_txn_alerts
         WHERE livemode AND direction ILIKE 'CR%' AND outcome IN ('UNMATCHED', 'AMBIGUOUS')
           AND matched_order_id IS NULL AND merchant_id IS NOT NULL AND event_time > now() - interval '7 days'
         GROUP BY 1`).catch(() => []);
      for (const x of r) items.push({
        key: `UNMATCHED_MONEY:${x.code}`, category: "UNMATCHED_MONEY", ...who(x.code),
        title: `${x.n} payment${x.n === 1 ? "" : "s"} to ${x.code} with no order (${inr(Number(x.total))})`,
        detail: "In the last 7 days. Link each one to its order, or mark it as not an order payment.",
        since: x.since, count: x.n,
        fix: { label: "Open unmatched payments", href: `/unmatched?banker=${encodeURIComponent(x.code)}` },
      });
    })().catch(() => {}),

    // Live orders still waiting well after they should have ended.
    (async () => {
      const r = await rows<{ code: string; ord: string; age: number; meta: unknown; at: string }>("vendorGateway", `
        SELECT merchant_id AS code, order_id AS ord, EXTRACT(EPOCH FROM now() - created_at)::int AS age, meta, created_at::text AS at
          FROM vendor_payin_orders
         WHERE livemode AND status = 'PENDING' AND created_at < now() - interval '20 minutes'
           AND created_at > now() - interval '30 days'
         ORDER BY created_at LIMIT 500`).catch(() => []);
      const per = new Map<string, { n: number; since: string; first: string }>();
      for (const x of r) {
        // Grace of 10 minutes after the order's own expiry, so the status sweep has had its turn.
        if (x.age < orderExpirySeconds(x.meta as never, true) + 600) continue;
        const p = per.get(x.code) ?? { n: 0, since: x.at, first: x.ord };
        p.n++; per.set(x.code, p);
      }
      for (const [code, p] of per) items.push({
        key: `STUCK_PENDING:${code}`, category: "STUCK_PENDING", ...who(code),
        title: `${p.n} live order${p.n === 1 ? "" : "s"} of ${code} stuck waiting`,
        detail: `Past their expiry and still waiting (oldest ${p.first}). The status check may be failing for this banker.`,
        since: p.since, count: p.n,
        fix: { label: "Open the banker", href: bankerHref(who(code).bankerId, code) },
      });
    })().catch(() => {}),

    // New payment accounts still taking only verification payments.
    (async () => {
      const r = await listGoLive().catch(() => []);
      const cutoff = Date.now() - VERIFYING_HOURS * 3600_000;
      for (const g of r) {
        if (g.status !== "VERIFYING" || new Date(g.created_at).getTime() > cutoff) continue;
        items.push({
          key: `VERIFYING_STUCK:${g.merchant_id}:${g.gateway}:${g.account}`, category: "VERIFYING_STUCK", ...who(g.merchant_id),
          title: `${g.merchant_id}'s ${g.gateway} account is still being verified`,
          detail: !g.webhook_at ? "No real payment has been confirmed on it yet. Make one, then set it live." : "A payment is confirmed. Finish the checklist and set it live.",
          since: g.created_at, count: 1,
          fix: { label: "Open Gateway go-live", href: "/gateway-golive" },
        });
      }
    })().catch(() => {}),
  ]);
  return items;
}

/** Every condition, freshly gathered at most once per CACHE_MS (`fresh` forces it). */
export async function attentionItems(fresh = false): Promise<AttentionItem[]> {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.items;
  const items = await gather();
  cache = { at: Date.now(), items };
  return items;
}

// ── Snoozes (merchant 0024) ───────────────────────────────────────────────────

async function snoozes(): Promise<Map<string, string>> {
  const r = await rows<{ key: string; until: string }>("merchant",
    `SELECT key, snoozed_until::text AS until FROM attention_snoozes WHERE snoozed_until > now()`).catch(() => []);
  return new Map(r.map((x) => [x.key, x.until]));
}

export async function attention(fresh = false): Promise<AttentionView & { checkedAt: string }> {
  const [items, snoozed] = await Promise.all([attentionItems(fresh), snoozes()]);
  return { ...attentionView(items, snoozed), checkedAt: new Date(cache?.at ?? Date.now()).toISOString() };
}

/** Hide a row for `hours` (24 by default), or show it again with hours = 0. */
export async function snoozeAttention(key: string, by: string, hours = 24, note: string | null = null): Promise<void> {
  if (hours <= 0) {
    await rows("merchant", `DELETE FROM attention_snoozes WHERE key = $1`, [key]);
    return;
  }
  await rows("merchant", `
    INSERT INTO attention_snoozes (key, snoozed_until, snoozed_by, note)
    VALUES ($1, now() + make_interval(hours => $2::int), $3, $4)
    ON CONFLICT (key) DO UPDATE SET snoozed_until = EXCLUDED.snoozed_until, snoozed_by = EXCLUDED.snoozed_by,
      note = EXCLUDED.note, updated_at = now()`, [key, Math.min(Math.round(hours), 24 * 30), by, note]);
}
