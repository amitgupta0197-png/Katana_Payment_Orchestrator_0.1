// Client helper: open a specific UPI app from a `upi://pay?…` intent string as
// reliably as the platform allows.
//
// Why not a plain <a href="paytmmp://…">: custom-scheme links are flaky at actually
// launching the target app on Android Chrome. The documented-reliable path on
// Android is an `intent://` URL carrying the app's package name — the OS routes to
// that exact app (and offers the Play Store if it isn't installed). On iOS / other
// platforms there is no intent:// , so we fall back to the app's custom URL scheme.
// "any" uses the generic `upi://pay` chooser (every UPI app registers it on Android).

export type UpiApp = "paytm" | "phonepe" | "gpay" | "any";

// Android package ids for the intent:// route.
const PKG: Record<UpiApp, string> = {
  paytm: "net.one97.paytm",
  phonepe: "com.phonepe.app",
  gpay: "com.google.android.apps.nbu.paisa.user",
  any: "",
};

// iOS / fallback custom URL schemes.
const SCHEME: Record<UpiApp, string> = {
  paytm: "paytmmp://pay",
  phonepe: "phonepe://pay",
  gpay: "tez://upi/pay",
  any: "upi://pay",
};

// Build the best launch URL for `app` from a `upi://pay?…` intent string.
export function upiAppUrl(app: UpiApp, upiIntent: string): string {
  const query = upiIntent.includes("?") ? upiIntent.split("?").slice(1).join("?") : "";
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const isAndroid = /android/i.test(ua);
  if (isAndroid && PKG[app]) {
    // intent:// keeps scheme=upi so the app parses the standard UPI params.
    return `intent://pay?${query}#Intent;scheme=upi;package=${PKG[app]};end`;
  }
  return `${SCHEME[app]}?${query}`;
}

/**
 * A processor's own app link (e.g. `paytmmp://cash_wallet?…`, `phonepe://native?…`), opened as
 * given. On Android it goes through intent:// with the app's package, the same reliable route as
 * above, keeping the link's own scheme, host and query.
 */
export function appLinkUrl(app: UpiApp, link: string): string {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const m = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(link);
  if (/android/i.test(ua) && PKG[app] && m) return `intent://${m[2]}#Intent;scheme=${m[1]};package=${PKG[app]};end`;
  return link;
}

/** Open the processor's own link for `app` when there is one, else the standard UPI link. */
export function openPayApp(app: UpiApp, upiIntent: string, appLinks?: Partial<Record<UpiApp, string>> | null): void {
  const own = app !== "any" ? appLinks?.[app] : undefined;
  if (own) { window.location.href = appLinkUrl(app, own); return; }
  openUpiApp(app, upiIntent);
}

// Navigate the current tab to the app. Custom schemes / intent URLs must be a
// top-level navigation (not target=_blank) for the OS handoff to fire.
export function openUpiApp(app: UpiApp, upiIntent: string): void {
  if (!upiIntent) return;
  window.location.href = upiAppUrl(app, upiIntent);
}
