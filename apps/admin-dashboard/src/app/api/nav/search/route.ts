// GET /api/nav/search?q= — the ⌘K search in the header (components/layout/nav-search.tsx).
//
// Pages: the caller's own menu (lib/nav personaNav, with flags and Access Matrix), hubbed pages
// included and named "FIFO › Reports". Entities (staff only, at most 8 per kind): merchants
// (`providers`), bankers (`merchants`) and TSPs, by code or name. A PROVIDER / MERCHANT session
// gets pages only, and only the pages its own menu shows; no entity of any kind.

import { NextResponse } from "next/server";
import { rows } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { rightsFor } from "@/lib/access";
import { serverFeatures } from "@/lib/features";
import { navItems, navTrail, personaNav, type NavAccess, type NavPersona } from "@/lib/nav";

export const dynamic = "force-dynamic";

const STAFF: NavPersona[] = ["SUPER_ADMIN", "ADMIN", "OPERATOR", "COMPLIANCE", "FINANCE", "RISK", "SUPPORT"];
const LIMIT = 8;

export interface NavSearchPage { href: string; label: string; trail: string; group: string }
export interface NavSearchEntity { kind: "merchant" | "banker" | "tsp"; id: string; code: string; name: string; href: string }

export async function GET(req: Request) {
  const g = await gateOrResponse([...STAFF, "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const persona = g.session.persona as NavPersona;
  const staff = STAFF.includes(persona);

  const q = (new URL(req.url).searchParams.get("q") ?? "").trim().slice(0, 80);
  if (q.length < 1) return NextResponse.json({ pages: [], entities: [] });

  let access: NavAccess | null = null;
  if (staff && persona !== "SUPER_ADMIN") {
    const rights = await rightsFor(persona).catch(() => ({}));
    access = Object.fromEntries(Object.entries(rights).map(([k, r]) => [k, { can_read: r.can_read }]));
  }
  const s = q.toLowerCase();
  const pages: NavSearchPage[] = personaNav(navItems, persona, { access, features: serverFeatures() })
    .map((i) => ({ href: i.href, label: i.label, trail: navTrail(i), group: i.group }))
    .filter((p) => p.trail.toLowerCase().includes(s) || p.group.toLowerCase().includes(s) || p.href.toLowerCase().includes(s))
    .slice(0, LIMIT);

  if (!staff || q.length < 2) return NextResponse.json({ pages, entities: [] });

  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const [merchants, bankers, tsps] = await Promise.all([
    rows<{ id: string; code: string; name: string }>("provider",
      `SELECT p.id::text AS id, p.code, COALESCE(p.legal_name, '') AS name FROM providers p
        WHERE p.code ILIKE $1 OR p.legal_name ILIKE $1 ORDER BY p.code LIMIT ${LIMIT}`, [like]).catch(() => []),
    rows<{ id: string; code: string; name: string }>("merchant",
      `SELECT m.id::text AS id, m.merchant_code AS code, COALESCE(m.legal_name, '') AS name FROM merchants m
        WHERE m.merchant_code ILIKE $1 OR m.legal_name ILIKE $1 ORDER BY m.merchant_code LIMIT ${LIMIT}`, [like]).catch(() => []),
    rows<{ id: string; code: string; name: string }>("merchant",
      `SELECT t.id::text AS id, t.code, COALESCE(t.name, '') AS name FROM tsps t
        WHERE t.code ILIKE $1 OR t.name ILIKE $1 ORDER BY t.code LIMIT ${LIMIT}`, [like]).catch(() => []),
  ]);
  const entities: NavSearchEntity[] = [
    ...merchants.map((r) => ({ kind: "merchant" as const, ...r, href: `/merchants/${r.id}` })),
    ...bankers.map((r) => ({ kind: "banker" as const, ...r, href: `/bankers/${r.id}` })),
    ...tsps.map((r) => ({ kind: "tsp" as const, ...r, href: `/tsps/${r.id}` })),
  ];
  return NextResponse.json({ pages, entities });
}
