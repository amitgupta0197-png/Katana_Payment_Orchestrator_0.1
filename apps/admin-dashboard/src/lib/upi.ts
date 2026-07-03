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

// Navigate the current tab to the app. Custom schemes / intent URLs must be a
// top-level navigation (not target=_blank) for the OS handoff to fire.
export function openUpiApp(app: UpiApp, upiIntent: string): void {
  if (!upiIntent) return;
  window.location.href = upiAppUrl(app, upiIntent);
}
