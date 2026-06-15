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
const STANDALONE_PREFIXES = ["/login", "/provider-portal", "/merchant-portal"];

async function isStandaloneShell(): Promise<boolean> {
  const h = await headers();
  const path =
    h.get("x-invoke-path") ??
    h.get("next-url") ??
    h.get("x-pathname") ??
    h.get("x-matched-path") ??
    "";
  return STANDALONE_PREFIXES.some((p) => path === p || path.startsWith(p + "/"));
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
                  className="flex-1 overflow-y-auto px-6 py-8 bg-[color:var(--color-surface-muted)]"
                >
                  <div className="mx-auto max-w-7xl">{children}</div>
                </main>
              </div>
            </div>
          )}
        </Providers>
      </body>
    </html>
  );
}
