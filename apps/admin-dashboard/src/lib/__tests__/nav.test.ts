// The staff menu (lib/nav): personaNav with hubs, feature flags and Access Matrix rows,
// sidebarNav, hub tabs and the ⌘K trail; and the flags themselves (lib/features).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hubByHref, hubTabs, navHubs, navItems, navTrail, personaNav, sidebarNav, type NavAccess, type NavPersona,
} from "@/lib/nav";
import { ALL_FEATURES_ON, featuresFrom } from "@/lib/features";

const hrefs = (p: NavPersona, o: Parameters<typeof personaNav>[2] = {}) => personaNav(navItems, p, o).map((i) => i.href);
const NEW_SECTIONS = ["/journeys", "/workflow-templates", "/chain", "/flows/intent", "/flows/p2p", "/flows/payout", "/flows/health", "/mdm", "/mdm/templates"];

test("every hub tab is an existing nav item, carried with its hub", () => {
  for (const h of navHubs) {
    assert.ok(navItems.some((i) => i.href === h.href && i.hub), h.href);
    for (const t of h.tabs) {
      const item = navItems.find((i) => i.href === t.href);
      assert.ok(item, t.href);
      assert.equal(item!.parent, h.href);
      assert.equal(item!.hubbed, true);
    }
  }
});

test("nothing is removed: every href is still in navItems once", () => {
  const all = navItems.map((i) => i.href);
  assert.equal(new Set(all).size, all.length);
  for (const h of ["/", "/merchants", "/bankers", "/transactions", "/gateway-health", "/admin/routing", "/admin/maker-checker", "/admin/refunds", "/operator", "/events", "/tsps", "/banks"]) {
    const i = navItems.find((x) => x.href === h);
    assert.ok(i && !i.parent, `${h} stays a standalone entry`);
  }
});

test("NAV_HUBS off gives the old flat menu exactly, in the old order", () => {
  const flags = { ...ALL_FEATURES_ON, NAV_HUBS: false, ONBOARDING_JOURNEYS: false, PAYMENT_FLOWS: false, MASTER_DATA: false };
  const flat = sidebarNav(personaNav(navItems, "SUPER_ADMIN", { features: flags }), flags);
  assert.ok(flat.every((i) => !i.hub));
  const old = navItems.filter((i) => !i.hub && !NEW_SECTIONS.includes(i.href) && (i.personas ?? ["SUPER_ADMIN"]).includes("SUPER_ADMIN"));
  assert.deepEqual(flat.map((i) => i.href), old.map((i) => i.href));
});

test("with hubs on, a hub stands in for its tabs in the sidebar; ⌘K still has the tabs", () => {
  const vis = personaNav(navItems, "SUPER_ADMIN");
  const side = sidebarNav(vis).map((i) => i.href);
  assert.ok(side.includes("/hub/fifo"));
  assert.ok(!side.includes("/fifo-reports"));
  assert.ok(vis.some((i) => i.href === "/fifo-reports"));
  assert.equal(navTrail(navItems.find((i) => i.href === "/fifo-reports")!), "FIFO › Reports");
  assert.equal(navTrail(navItems.find((i) => i.href === "/merchants")!), "Merchants");
});

test("a curated persona sees a hub only for the tabs it already had", () => {
  const vis = personaNav(navItems, "OPERATOR");
  const fifo = hubByHref("/hub/fifo")!;
  assert.deepEqual(hubTabs(fifo, vis, "OPERATOR").map((t) => t.key), ["dashboard"]);
  assert.ok(vis.some((i) => i.href === "/hub/fifo"));
  assert.ok(!vis.some((i) => i.href === "/hub/dt"));
  // OPERATOR keeps its /security entry, now inside the Security hub.
  assert.ok(sidebarNav(vis).some((i) => i.href === "/hub/security"));
  assert.ok(!sidebarNav(vis).some((i) => i.href === "/security"));
});

test("hub tabs the middleware keeps for SUPER_ADMIN are not offered to ADMIN", () => {
  const vis = personaNav(navItems, "ADMIN");
  assert.deepEqual(hubTabs(hubByHref("/hub/security")!, vis, "ADMIN").map((t) => t.key), ["mfa"]);
  assert.ok(!vis.some((i) => i.href === "/hub/identity"), "every identity tab is under /admin");
  assert.ok(!vis.some((i) => i.href === "/hub/adapters"));
  assert.equal(hubTabs(hubByHref("/hub/identity")!, personaNav(navItems, "SUPER_ADMIN"), "SUPER_ADMIN").length, 4);
});

test("PROVIDER and MERCHANT: exactly the old menu, no hubs, no new sections", () => {
  for (const p of ["PROVIDER", "MERCHANT"] as const) {
    const vis = personaNav(navItems, p);
    assert.ok(vis.every((i) => !i.hub));
    assert.ok(!vis.some((i) => NEW_SECTIONS.includes(i.href) || i.href === "/tsps" || i.href === "/banks"));
    assert.deepEqual(sidebarNav(vis).map((i) => i.href), ["/", "/security"]);
  }
});

test("new sections follow their persona lists and flags", () => {
  assert.ok(hrefs("SUPPORT").includes("/flows/health"));
  assert.ok(!hrefs("SUPPORT").includes("/journeys"));
  assert.ok(hrefs("RISK").includes("/journeys"));
  assert.ok(!hrefs("RISK").includes("/mdm"));
  assert.ok(hrefs("ADMIN").includes("/mdm/templates"));
  const off = { ...ALL_FEATURES_ON, PAYMENT_FLOWS: false, PROVIDER_MANAGEMENT: false };
  const h = hrefs("SUPER_ADMIN", { features: off });
  assert.ok(!h.includes("/flows/p2p") && !h.includes("/tsps"));
  assert.ok(h.includes("/journeys"));
});

test("Access Matrix: no read on a module hides its entry; no rows changes nothing", () => {
  const before = hrefs("RISK");
  assert.deepEqual(hrefs("RISK", { access: {} }), before);
  assert.deepEqual(hrefs("RISK", { access: null }), before);
  const access: NavAccess = { risk: { can_read: false }, aml_cases: { can_read: true } };
  const after = hrefs("RISK", { access });
  assert.ok(!after.includes("/risk") && !after.includes("/risk/aml"));
  assert.ok(after.includes("/cases"));
  // An entry without a module is untouched.
  assert.ok(after.includes("/forensics"));
});

test("Access Matrix: a mapped module with no row is hidden once the persona has rows", () => {
  const after = hrefs("RISK", { access: { aml_cases: { can_read: true } } });
  assert.ok(!after.includes("/risk"));
  assert.ok(after.includes("/cases"));
});

test("Access Matrix: SUPER_ADMIN always sees all", () => {
  const deny: NavAccess = Object.fromEntries(navItems.filter((i) => i.module).map((i) => [i.module!, { can_read: false }]));
  assert.deepEqual(hrefs("SUPER_ADMIN", { access: deny }), hrefs("SUPER_ADMIN"));
});

test("Access Matrix: a hub whose readable tabs are all denied disappears", () => {
  const vis = personaNav(navItems, "FINANCE", { access: { reserves: { can_read: false }, partner_data: { can_read: true }, commission: { can_read: true } } });
  assert.ok(!vis.some((i) => i.href === "/hub/finance"), "FINANCE had only /reserves in the Finance hub");
  assert.ok(vis.some((i) => i.href === "/hub/dt"));
});

test("feature flags: on unless FEATURE_<NAME>=0", () => {
  assert.deepEqual(featuresFrom({}), ALL_FEATURES_ON);
  const f = featuresFrom({ FEATURE_NAV_HUBS: "0", FEATURE_MASTER_DATA: "false", FEATURE_PAYMENT_FLOWS: "1" });
  assert.equal(f.NAV_HUBS, false);
  assert.equal(f.MASTER_DATA, false);
  assert.equal(f.PAYMENT_FLOWS, true);
  assert.equal(f.ONBOARDING_JOURNEYS, true);
});
