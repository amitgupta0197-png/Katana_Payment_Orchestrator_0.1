// Who may see and change what in the partner module (/api/partners/*). One set of routes serves
// Katana staff and the partner's own merchant-portal login (PROVIDER, which names its partner "me").
//
//   read                          every staff role; the partner itself
//   partner settings              Super Admin, Admin (make a partner, suspend, exclusive, own gateway, auto-approve)
//   review a sub-merchant         Super Admin, Admin, Compliance (approve / reject / suspend / reactivate)
//   add / edit a sub-merchant     Super Admin, Admin, Operator; the partner itself (its own wait for review)
//   API keys and webhook          Super Admin, Admin; the partner itself
//
// A partner is a merchant (lib/merchant-safe): it is never shown a gateway's name, so its view
// of its own record leaves out own_gateway and the settings history.

import { NextResponse } from "next/server";
import type { Session } from "@/lib/auth";
import { STAFF_PERSONAS } from "@/lib/portal-scope";
import { seesGatewayNames, stripGatewayNames } from "@/lib/merchant-safe";
import { getPartner, partnerForProvider, type PartnerEventRow, type PartnerRow } from "@/lib/partner/store";

export const PARTNER_READERS = [...STAFF_PERSONAS, "PROVIDER"] as const;
const SETTINGS = new Set(["SUPER_ADMIN", "ADMIN"]);
const REVIEW = new Set(["SUPER_ADMIN", "ADMIN", "COMPLIANCE"]);
const EDIT_STAFF = new Set(["SUPER_ADMIN", "ADMIN", "OPERATOR"]);
const KEYS_STAFF = new Set(["SUPER_ADMIN", "ADMIN"]);

export const can = {
  settings: (s: Session) => SETTINGS.has(s.persona),
  review: (s: Session) => REVIEW.has(s.persona),
  editSubs: (s: Session) => EDIT_STAFF.has(s.persona) || s.persona === "PROVIDER",
  keys: (s: Session) => KEYS_STAFF.has(s.persona) || s.persona === "PROVIDER",
};

export const isStaff = (s: Session) => seesGatewayNames(s.persona);

/** The partner a request is about: staff name one by id; a partner login gets only its own ("me" or its id). */
export async function partnerInScope(s: Session, id: string): Promise<PartnerRow | null> {
  if (s.persona === "PROVIDER") {
    const own = await partnerForProvider(s.scope_id);
    return own && (id === "me" || id === own.id) ? own : null;
  }
  if (!isStaff(s)) return null;
  return getPartner(id);
}

export const notFound = () => NextResponse.json({ error: "not found" }, { status: 404 });
export const forbidden = (what: string) => NextResponse.json({ error: `you cannot ${what}` }, { status: 403 });

/** The partner record as the viewer may see it. */
export function partnerView(p: PartnerRow, staff: boolean) {
  if (staff) return p;
  const { own_gateway: _g, ...rest } = p;
  return rest;
}

/** Events as the viewer may see them: a partner never sees settings changes or a processor's name. */
export function eventsView(list: PartnerEventRow[], staff: boolean) {
  if (staff) return list;
  return list.filter((e) => e.action !== "PARTNER").map((e) => ({
    ...e,
    actor: e.actor.startsWith("partner:") ? "You" : e.actor === "system" || e.actor === "auto-approve" ? "Katana" : "Katana operations",
    detail: JSON.parse(stripGatewayNames(JSON.stringify(e.detail), "processor")),
  }));
}

/** How a person is written into the partner's records: staff as "katana:<email>", the partner's own login as "partner:<code>:<email>". */
export function actorOf(s: Session, p: PartnerRow): string {
  return isStaff(s) ? `katana:${s.email}` : `partner:${p.code}:${s.email}`;
}
