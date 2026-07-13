import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";
import { Providers } from "@/components/providers";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";

export const metadata: Metadata = {
  title: {
    template: "%s · Katana",
    default: "Katana — Payment Orchestrator",
  },
  description: "Operations console for the Katana Payment Orchestrator platform",
};

// Persona portals + login own their chrome. Sniff the path Next.js sets in
// request headers so the SUPER_ADMIN sidebar/header don't leak into them.
const STANDALONE_PREFIXES = ["/login", "/provider-portal", "/merchant-portal", "/pay", "/developers", "/katana-pay"];

async function isStandaloneShell(): Promise<boolean> {
  const h = await headers();
  // Check ALL known path headers (not first-non-null): in some Next versions an
  // internal header like x-invoke-path / next-url is present but doesn't carry the
  // real pathname, which would shadow our own reliable middleware-set x-pathname and
  // wrongly wrap a portal in the admin shell (double sidebar).
  const candidates = [
    h.get("x-pathname"),     // set by our middleware — most reliable
    h.get("x-invoke-path"),
    h.get("next-url"),
    h.get("x-matched-path"),
  ].filter((p): p is string => !!p);
  return candidates.some((path) =>
    STANDALONE_PREFIXES.some((p) => path === p || path.startsWith(p + "/")));
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const standalone = await isStandaloneShell();

  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers>
          <a
            href="#main-content"
            className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-[color:var(--color-brand)] focus:px-3 focus:py-1.5 focus:text-[color:var(--color-brand-fg)] focus:text-sm"
          >
            Skip to content
          </a>
          {standalone ? (
            <div id="main-content">{children}</div>
          ) : (
            <div className="flex min-h-screen">
              <Sidebar />
              <div className="flex flex-1 flex-col min-w-0">
                <Header />
                <main
                  id="main-content"
                  role="main"
                  tabIndex={-1}
                  className="app-canvas flex-1 overflow-x-hidden overflow-y-auto px-4 py-6 md:px-6 md:py-8"
                >
                  <div className="mx-auto min-w-0 max-w-7xl">{children}</div>
                </main>
              </div>
            </div>
          )}
        </Providers>
      </body>
    </html>
  );
}
