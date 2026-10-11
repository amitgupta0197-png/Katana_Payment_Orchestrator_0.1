// The banker onboarding wizard (staff, Super Admin): one question at a time, built on Katana's
// banker model. Pure: the steps, what each needs, and the calls that set the banker up.
// UI in components/merchant/banker-wizard.tsx; every call goes through the existing APIs, so
// their checks (code taken, VPA form, gateway credentials, H2H rule) still apply.
//
//   P2P banker
//     Scan and pay          the customer scans the banker's own static QR; the agent phone confirms
//                           app: BharatPe | Google Pay | PhonePe | Paytm | other static QR
//     Scan, pay and verify  quasi channel / P2P intent: a processor issues the link, the money lands
//                           with the banker, the processor verifies (PayAtom)
//   Intent banker           a gateway takes the payment and confirms it by callback
//                           (PayU, Cashfree, RubyVault, Razorpay, … ; Easebuzz not connected yet)

import { methodForApp, type P2pApp, type P2pKind, type P2pMethod } from "@/lib/p2p-method";

export type BankerType = "P2P" | "INTENT";
export type Env = "TEST" | "PROD";

export interface WizardAnswers {
  providerId: string;
  name: string;
  code: string;
  email: string;
  phone: string;
  type: BankerType | null;
  // P2P
  kind: P2pKind | null;
  app: P2pApp | null;
  upiId: string;
  payeeName: string;
  bharatpeEnv: Env;
  bharatpeMid: string;
  payatom: { env: Env; pid: string; secret: string; apiKey: string; apiBase: string; latitude: string; longitude: string };
  // Intent
  gateway: string | null;
  gatewayEnv: Env;
  gatewayAuth: string | null;
  gatewayFields: Record<string, string>;
  /** Skip the account for now; finish it on the banker page. */
  connectLater: boolean;
}

export const EMPTY_ANSWERS: WizardAnswers = {
  providerId: "", name: "", code: "", email: "", phone: "", type: null,
  kind: null, app: null, upiId: "", payeeName: "", bharatpeEnv: "TEST", bharatpeMid: "",
  payatom: { env: "TEST", pid: "", secret: "", apiKey: "", apiBase: "", latitude: "", longitude: "" },
  gateway: null, gatewayEnv: "TEST", gatewayAuth: null, gatewayFields: {}, connectLater: false,
};

export type StepKey = "merchant" | "banker" | "type" | "kind" | "app" | "upi" | "payatom" | "gateway" | "credentials" | "review";

/** The steps for these answers, in order. Later steps depend on earlier choices. */
export function wizardSteps(a: WizardAnswers): StepKey[] {
  const s: StepKey[] = ["merchant", "banker", "type"];
  if (a.type === "P2P") {
    s.push("kind");
    if (a.kind === "SCAN_PAY") s.push("app", "upi");
    else if (a.kind === "QUASI") s.push("payatom");
  } else if (a.type === "INTENT") {
    s.push("gateway");
    if (!a.connectLater) s.push("credentials");
  }
  s.push("review");
  return s;
}

const VPA_RE = /^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9.-]{1,64}$/;
const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface FieldSpec { name: string; label: string; optional?: boolean; pattern?: string }

/** What stops this step, in plain words; null when it may move on. */
export function stepProblem(step: StepKey, a: WizardAnswers, ctx: { codeTaken?: boolean; gatewayFields?: FieldSpec[] } = {}): string | null {
  switch (step) {
    case "merchant": return a.providerId ? null : "Choose the merchant this banker belongs to";
    case "banker":
      if (a.name.trim().length < 2) return "Enter the banker's name";
      if (!CODE_RE.test(a.code.trim().toUpperCase())) return "Banker code: 2–32 letters, digits, - or _";
      if (ctx.codeTaken) return "That banker code is taken";
      if (!EMAIL_RE.test(a.email.trim())) return "Enter a contact email";
      if (a.phone.trim() && !/^\+?[0-9 ]{10,15}$/.test(a.phone.trim())) return "Phone: 10 digits";
      return null;
    case "type": return a.type ? null : "Choose P2P or Intent";
    case "kind": return a.kind ? null : "Choose how the customer pays";
    case "app": return a.app ? null : "Choose the app the QR belongs to";
    case "upi":
      if (!VPA_RE.test(a.upiId.trim())) return a.app === "BHARATPE" ? "Enter the BharatPe QR's UPI ID (name@bank)" : "Enter the UPI ID customers pay (name@bank)";
      if (a.app === "BHARATPE" && a.bharatpeMid.trim() && !/^\d{1,24}$/.test(a.bharatpeMid.trim())) return "BharatPe merchant ID is digits only";
      return null;
    case "payatom": {
      if (a.connectLater) return null;
      const p = a.payatom;
      if (!p.pid.trim() || !p.secret.trim() || !p.apiKey.trim() || !p.apiBase.trim()) return "Enter PayAtom's PID, secret key, API key and API base URL — or connect it later";
      if (!/^https:\/\//i.test(p.apiBase.trim())) return "API base URL starts with https://";
      if (p.secret.trim() === p.apiKey.trim()) return "The secret key and the API key are different values";
      if (!/^-?\d{1,3}(\.\d+)?$/.test(p.latitude.trim()) || !/^-?\d{1,3}(\.\d+)?$/.test(p.longitude.trim())) return "PayAtom needs a latitude and longitude, e.g. 19.0760 and 72.8777";
      return null;
    }
    case "gateway": return a.gateway || a.connectLater ? null : "Choose the gateway, or connect it later";
    case "credentials": {
      for (const f of ctx.gatewayFields ?? []) {
        const v = (a.gatewayFields[f.name] ?? "").trim();
        if (!v && !f.optional) return `Enter ${f.label}`;
        if (v && f.pattern && !new RegExp(f.pattern).test(v)) return `${f.label} doesn't look right`;
      }
      return null;
    }
    case "review": return null;
  }
}

/** The P2P method these answers put the banker on, or null for an Intent banker. */
export function wizardMethod(a: WizardAnswers): P2pMethod | null {
  if (a.type !== "P2P") return null;
  if (a.kind === "QUASI") return "PAYATOM";
  return a.app ? methodForApp(a.app) : null;
}

/** One setup call. `id` is the new banker's id, known after the first call. */
export interface WizardCall {
  key: string;
  label: string;
  method: "POST" | "PUT" | "PATCH";
  path: (id: string) => string;
  body: Record<string, unknown>;
  /** A failure here leaves the banker created; the rest can be finished on its page. */
  optional?: boolean;
}

/** The calls that create and set up the banker, in order. */
export function wizardCalls(a: WizardAnswers): WizardCall[] {
  const code = a.code.trim().toUpperCase();
  const calls: WizardCall[] = [{
    key: "create", label: "Create the banker and its login", method: "POST", path: () => "/api/merchants",
    body: {
      merchant_code: code, legal_name: a.name.trim(), brand_name: a.name.trim(), contact_email: a.email.trim(),
      ...(a.phone.trim() ? { contact_phone: a.phone.trim() } : {}), provider_id: a.providerId,
    },
  }];
  if (!a.type) return calls;
  calls.push({ key: "flow", label: `Set it to ${a.type === "P2P" ? "P2P" : "Intent"}`, method: "PUT",
    path: (id) => `/api/merchants/${id}/payin-flow`, body: { flow: a.type, note: "banker onboarding wizard" } });

  if (a.type === "P2P") {
    const method = wizardMethod(a);
    if (a.kind === "SCAN_PAY" && a.app === "BHARATPE") {
      calls.push({ key: "bharatpe", label: "Connect BharatPe (its UPI ID becomes the one customers pay)", method: "POST",
        path: (id) => `/api/merchants/${id}/bharatpe`,
        body: { label: `${code} BharatPe`, payee_vpa: a.upiId.trim(), env: a.bharatpeEnv, replace_primary: true,
          ...(a.bharatpeMid.trim() ? { bharatpe_merchant_id: a.bharatpeMid.trim() } : {}) } });
    } else if (a.kind === "SCAN_PAY") {
      calls.push({ key: "upi", label: "Save the UPI ID customers pay", method: "PATCH",
        path: (id) => `/api/merchants/${id}/payment-config`,
        body: { katana_pay: { settlement_vpa: a.upiId.trim(), ...(a.payeeName.trim() ? { payee_name: a.payeeName.trim() } : {}) } } });
    } else if (a.kind === "QUASI" && !a.connectLater) {
      const p = a.payatom;
      calls.push({ key: "payatom", label: "Connect PayAtom (P2P: money lands with the banker)", method: "POST",
        path: (id) => `/api/merchants/${id}/payatom`,
        body: { want: { p2p: true, intent: false }, env: p.env, latitude: p.latitude.trim(), longitude: p.longitude.trim(),
          p2p: { pid: p.pid.trim(), secret: p.secret.trim(), api_key: p.apiKey.trim(), api_base: p.apiBase.trim() } } });
    }
    if (method) calls.push({ key: "method", label: "Choose its P2P method", method: "PUT",
      path: (id) => `/api/merchants/${id}/p2p-method`,
      body: { method, ...(a.kind === "SCAN_PAY" && a.app ? { app: a.app } : {}), note: "banker onboarding wizard" } });
  } else if (a.gateway && !a.connectLater) {
    calls.push({ key: "gateway", label: "Connect the payment gateway", method: "POST",
      path: (id) => `/api/merchants/${id}/gateway-mid`,
      body: { gateway: a.gateway, env: a.gatewayEnv, ...(a.gatewayAuth ? { auth: a.gatewayAuth } : {}),
        fields: Object.fromEntries(Object.entries(a.gatewayFields).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v)) } });
  }
  return calls;
}

/** What is still to do after the wizard, in plain words. */
export function afterSteps(a: WizardAnswers): string[] {
  const out: string[] = [];
  if (a.type === "P2P" && a.kind === "SCAN_PAY") {
    out.push(a.app === "BHARATPE"
      ? "Install the Katana Agent on the banker's phone, switch on BharatPe for Business and paste the BharatPe key + secret shown below."
      : `Install the Katana Agent on the banker's phone and switch on ${a.app === "OTHER" ? "bank SMS / the QR's app" : (a.app ? { GPAY: "Google Pay for Business", PHONEPE: "PhonePe for Business", PAYTM: "Paytm for Business" }[a.app as "GPAY" | "PHONEPE" | "PAYTM"] : "its payment app")}.`);
  }
  if (a.type === "P2P" && a.kind === "QUASI") out.push(a.connectLater
    ? "Connect PayAtom on the banker's \"Pays UPI ID\" tab."
    : "Ask PayAtom to whitelist 72.61.227.233 and set the callback URL https://katanapay.co/api/gateway/payatom/webhook for this PID.");
  if (a.type === "INTENT") out.push(a.connectLater || !a.gateway
    ? "Connect the payment gateway on the banker's \"Pays via gateway\" tab."
    : "Make one real payment at the gateway's minimum, then set the account live on Gateway go-live.");
  out.push("Take it through onboarding approval and \"Activate live mode\" on the banker page.");
  return out;
}
