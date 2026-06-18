// Global search across the platform's primary entities. Used by the Cmd+K
// command palette. Persona-scoped: PROVIDER/MERCHANT only see entities in
// their scope (relies on scope.ts gating at the table level).
//
// Returns up to 5 results per entity kind, all unioned in one response so
// the palette can render a single ranked list.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

interface Hit {
  kind: string;
  id: string;
  title: string;
  subtitle: string;
  href: string;
}

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q.length < 2) return NextResponse.json({ hits: [] });

  const like = `%${q}%`;
  const hits: Hit[] = [];

  // Providers — SUPER_ADMIN + PROVIDER (own row only).
  if (g.session.persona === "SUPER_ADMIN" || g.session.persona === "PROVIDER") {
    const scoped: unknown[] = ["tenant-default", like, like];
    let where = "tenant_id = $1 AND (code ILIKE $2 OR legal_name ILIKE $3)";
    if (g.session.persona === "PROVIDER") { where += " AND id = $4::uuid"; scoped.push(g.session.scope_id); }
    const r = await rows<any>("provider",
      `SELECT id::text, code, legal_name FROM providers WHERE ${where} LIMIT 5`, scoped).catch(() => []);
    for (const p of r) hits.push({ kind: "provider", id: p.id, title: p.code, subtitle: p.legal_name, href: `/providers/${p.id}` });
  }

  // Merchants — SUPER_ADMIN + PROVIDER (via mapping) + MERCHANT (own).
  if (g.session.persona === "SUPER_ADMIN") {
    const r = await rows<any>("merchant",
      `SELECT id::text, merchant_code, legal_name FROM merchants WHERE merchant_code ILIKE $1 OR legal_name ILIKE $2 LIMIT 5`,
      [like, like]).catch(() => []);
    for (const m of r) hits.push({ kind: "merchant", id: m.id, title: m.merchant_code, subtitle: m.legal_name, href: `/merchants/${m.id}` });
  } else if (g.session.persona === "MERCHANT") {
    const r = await rows<any>("merchant",
      `SELECT id::text, merchant_code, legal_name FROM merchants WHERE merchant_code = $1 LIMIT 1`,
      [g.session.scope_id]).catch(() => []);
    for (const m of r) hits.push({ kind: "merchant", id: m.id, title: m.merchant_code, subtitle: m.legal_name, href: `/merchant-portal` });
  }

  // Tenants — SUPER_ADMIN only.
  if (g.session.persona === "SUPER_ADMIN") {
    const r = await rows<any>("tenant",
      `SELECT id::text, code, name FROM tenants WHERE code ILIKE $1 OR name ILIKE $2 LIMIT 5`,
      [like, like]).catch(() => []);
    for (const t of r) hits.push({ kind: "tenant", id: t.id, title: t.code, subtitle: t.name, href: `/tenants` });
  }

  return NextResponse.json({ hits });
}
