// Onboarding gates: the checks made by the system when a banker is moved through onboarding
// (POST /api/merchants/[id]/advance). Each run is recorded in merchant_onboarding_gates
// (merchant 0013) with operator SYSTEM.
//
//   step_application  APPLICATION  the KYB identifiers are well-formed and agree with each other;
//                                  the category is one that may be onboarded
//                     WEBSITE      the website answers over HTTPS and does not advertise a
//                                  prohibited line of business
//   step_kyb_docs     DOCUMENTS    the documents the application calls for are uploaded
//   step_screening    SCREENING    the business and its director are not on the sanctions or
//                                  PEP lists Katana holds
//
// A gate answers PASS, REVIEW or FAIL:
//
//   FAIL    a reason to stop: a malformed identifier, a prohibited category, a sanctions hit.
//           The step is refused; a Super Admin may override it with a note, which is recorded.
//   REVIEW  the system could not clear it (something is missing, or a person has to judge).
//           The step goes ahead and the result is shown, unless ONBOARDING_STRICT=1, which
//           makes a REVIEW refuse the step the same way.
//
// WHAT THESE DO NOT DO. They check form and Katana's own lists. They do not ask the GST
// network whether a GSTIN is active, verify a PAN against a name, run an Aadhaar e-KYC or send
// a penny-drop: each of those needs a provider Katana has no contract with yet. Bank
// verification therefore stays a person's step.

import { rows } from "@/lib/pg";
import { safeFetch } from "@/lib/safe-fetch";
import { screenName } from "@/lib/risk";
import {
  aadhaarLast4Problem, gstinPan, gstinProblem, mccProblem, mccStanding, panProblem, prohibitedWords, tidyId,
} from "@/lib/kyc-validators";

export type GateName = "APPLICATION" | "WEBSITE" | "DOCUMENTS" | "SCREENING";
export type GateResult = "PASS" | "REVIEW" | "FAIL";

export interface GateOutcome {
  gate: GateName;
  result: GateResult;
  /** One line a person can act on. */
  summary: string;
  detail: Record<string, unknown>;
}

export interface OnboardingSubject {
  id: string;
  legal_name: string;
  brand_name: string | null;
  category_mcc: string | null;
  website: string | null;
  gstin: string | null;
  business_pan: string | null;
  director_name: string | null;
  director_pan: string | null;
  director_aadhaar_last4: string | null;
}

export const SUBJECT_COLS = `id::text, legal_name, brand_name, category_mcc, website, gstin, business_pan,
  director_name, director_pan, director_aadhaar_last4`;

const worst = (problems: number, missing: number): GateResult => (problems ? "FAIL" : missing ? "REVIEW" : "PASS");

/** The application's identifiers: well-formed, consistent, and a category that may be onboarded. Pure. */
export function gateApplication(m: OnboardingSubject): GateOutcome {
  const problems: Record<string, string> = {};
  const missing: string[] = [];
  const check = (field: string, value: string | null, problem: (v: string) => string | null) => {
    if (!value?.trim()) { missing.push(field); return; }
    const p = problem(value);
    if (p) problems[field] = p;
  };
  check("gstin", m.gstin, gstinProblem);
  check("business_pan", m.business_pan, panProblem);
  check("director_pan", m.director_pan, panProblem);
  check("director_aadhaar_last4", m.director_aadhaar_last4, aadhaarLast4Problem);
  check("category_mcc", m.category_mcc, mccProblem);
  if (!m.director_name?.trim()) missing.push("director_name");

  // A GSTIN is issued on a PAN, so the two must agree.
  if (m.gstin && m.business_pan && !problems.gstin && !problems.business_pan && gstinPan(m.gstin) !== tidyId(m.business_pan))
    problems.gstin = "the GSTIN was not issued on this business PAN";

  const mcc = mccStanding(m.category_mcc);
  if (mcc.standing === "PROHIBITED") problems.category_mcc = `prohibited category: ${mcc.reason}`;
  const review = mcc.standing === "REVIEW" ? [`category needs a licence check: ${mcc.reason}`] : [];

  const result = worst(Object.keys(problems).length, missing.length + review.length);
  const summary = result === "PASS" ? "Identifiers are well-formed and agree"
    : result === "FAIL" ? Object.entries(problems).map(([f, p]) => `${f}: ${p}`).join("; ")
    : [missing.length ? `not supplied: ${missing.join(", ")}` : "", ...review].filter(Boolean).join("; ");
  return { gate: "APPLICATION", result, summary, detail: { problems, missing, review } };
}

/** The website answers over HTTPS and does not advertise a prohibited business. */
export async function gateWebsite(website: string | null): Promise<GateOutcome> {
  const url = website?.trim();
  if (!url) return { gate: "WEBSITE", result: "REVIEW", summary: "no website supplied", detail: {} };
  if (!/^https:\/\//i.test(url))
    return { gate: "WEBSITE", result: "REVIEW", summary: "the website is not HTTPS", detail: { url } };
  try {
    // safeFetch refuses private and loopback addresses, so a website field cannot point inward.
    // A redirect is not followed for the same reason: its target has not been checked.
    const res = await safeFetch(url, { method: "GET", redirect: "manual", headers: { "user-agent": "KatanaOnboardingCheck/1.0" } });
    if (res.status >= 300 && res.status < 400)
      return { gate: "WEBSITE", result: "PASS", summary: "The website is live over HTTPS (it redirects, so its content was not read)",
        detail: { url, status: res.status, redirects_to: res.headers.get("location") } };
    const html = (await res.text()).slice(0, 300_000);
    const words = prohibitedWords(html);
    const detail = { url, status: res.status, words };
    if (res.status >= 400) return { gate: "WEBSITE", result: "REVIEW", summary: `the website answered ${res.status}`, detail };
    if (words.length) return { gate: "WEBSITE", result: "REVIEW", summary: `the website mentions: ${words.join(", ")}`, detail };
    return { gate: "WEBSITE", result: "PASS", summary: "The website is live over HTTPS", detail };
  } catch (err) {
    // Down today is not a reason to refuse: the spec allows a grace period, so a person looks.
    return { gate: "WEBSITE", result: "REVIEW", summary: "the website could not be reached", detail: { url, error: (err as Error).message.slice(0, 200) } };
  }
}

/** The document types an application calls for. A GST certificate only when a GSTIN was given. */
export function requiredDocuments(m: Pick<OnboardingSubject, "gstin">): string[] {
  return ["PAN", ...(m.gstin?.trim() ? ["GST"] : []), "BANK_STATEMENT"];
}

/** The documents the application calls for are uploaded. */
export async function gateDocuments(m: OnboardingSubject): Promise<GateOutcome> {
  const have = (await rows<{ doc_type: string }>("merchant",
    `SELECT DISTINCT doc_type FROM merchant_kyb_documents WHERE merchant_id = $1::uuid`, [m.id])).map((d) => d.doc_type);
  const required = requiredDocuments(m);
  const missing = required.filter((d) => !have.includes(d));
  return {
    gate: "DOCUMENTS", result: missing.length ? "REVIEW" : "PASS",
    summary: missing.length ? `not uploaded: ${missing.join(", ")}` : "The required documents are uploaded",
    detail: { required, uploaded: have, missing },
  };
}

/** The business and its director against the sanctions and PEP lists Katana holds. */
export async function gateScreening(m: OnboardingSubject): Promise<GateOutcome> {
  const names = [...new Set([m.legal_name, m.brand_name, m.director_name].map((n) => n?.trim()).filter((n): n is string => !!n))];
  const hits: { name: string; source: string; kind: string }[] = [];
  for (const name of names) {
    const r = await screenName({ fullName: name });
    for (const h of r.hits) hits.push({ name, source: h.source, kind: h.match_kind });
  }
  const listSize = (await rows<{ n: number }>("riskVelocity",
    `SELECT (SELECT COUNT(*) FROM sanctions_list)::int + (SELECT COUNT(*) FROM pep_list)::int AS n`).catch(() => [{ n: 0 }]))[0]?.n ?? 0;
  const detail = { screened: names, hits, list_entries: listSize, match: "exact name" };
  if (hits.some((h) => h.kind === "SANCTIONS"))
    return { gate: "SCREENING", result: "FAIL", summary: `sanctions list match: ${hits.filter((h) => h.kind === "SANCTIONS").map((h) => h.name).join(", ")}`, detail };
  if (hits.length)
    return { gate: "SCREENING", result: "REVIEW", summary: `politically exposed person match: ${hits.map((h) => h.name).join(", ")}`, detail };
  // An empty or tiny list clears nobody: say so rather than report a PASS that means nothing.
  if (listSize < 100)
    return { gate: "SCREENING", result: "REVIEW", summary: `no match, but the lists hold only ${listSize} entries: screen against a full list before relying on this`, detail };
  return { gate: "SCREENING", result: "PASS", summary: "No sanctions or PEP match", detail };
}

export type OnboardingStep = "step_application" | "step_kyb_docs" | "step_screening" | "step_bank_verify" | "step_config" | "step_approval";

/** Run the gates of one onboarding step. Steps with no system check return none. */
export async function runStepGates(step: OnboardingStep, m: OnboardingSubject): Promise<GateOutcome[]> {
  if (step === "step_application") return [gateApplication(m), await gateWebsite(m.website)];
  if (step === "step_kyb_docs") return [await gateDocuments(m)];
  if (step === "step_screening") return [await gateScreening(m)];
  return [];
}

export const strictOnboarding = () => process.env.ONBOARDING_STRICT === "1";

/** The gates that refuse the step: every FAIL, and every REVIEW when onboarding is strict. */
export function blockingGates(gates: GateOutcome[], strict = strictOnboarding()): GateOutcome[] {
  return gates.filter((g) => g.result === "FAIL" || (strict && g.result === "REVIEW"));
}

/** Record gate runs. `overriddenBy` is set on the blocking ones a person let through. */
export async function recordGates(merchantId: string, gates: GateOutcome[], overriddenBy: string | null = null): Promise<void> {
  const blocking = new Set(blockingGates(gates).map((g) => g.gate));
  for (const g of gates) {
    await rows("merchant", `
      INSERT INTO merchant_onboarding_gates (merchant_id, gate, result, detail, overridden_by)
      VALUES ($1::uuid, $2, $3, $4::jsonb, $5)
    `, [merchantId, g.gate, g.result, JSON.stringify({ summary: g.summary, ...g.detail }), blocking.has(g.gate) ? overriddenBy : null]);
  }
}

export interface GateRow { id: string; gate: GateName; result: GateResult; detail: Record<string, unknown>; operator: string; overridden_by: string | null; checked_at: string }

export async function listGates(merchantId: string, limit = 50): Promise<GateRow[]> {
  return rows<GateRow>("merchant", `
    SELECT id::text, gate, result, detail, operator, overridden_by, checked_at
      FROM merchant_onboarding_gates g WHERE merchant_id = $1::uuid ORDER BY g.id DESC LIMIT ${Math.min(limit, 200)}
  `, [merchantId]);
}
