import { headers } from "next/headers";
import { LogOut, Shield } from "lucide-react";
import { getSession } from "@/lib/auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LogoutButton } from "./logout-button";
import { ThemeToggle } from "./theme-toggle";
import { MobileNav } from "./sidebar";
import { NavSearch } from "./nav-search";

export async function Header() {
  // headers() is awaited so we can later read x-session-persona if needed.
  await headers();
  const session = await getSession();
  const personaLabel: Record<string, string> = {
    SUPER_ADMIN: "Super Admin", PROVIDER: "Provider", MERCHANT: "Branch",
  };

  return (
    <header
      role="banner"
      className="flex h-16 items-center justify-between gap-3 border-b bg-[color:var(--color-surface)] px-4 md:px-6"
    >
      <div className="flex items-center gap-3 min-w-0">
        <MobileNav />
        <Shield className="h-4 w-4 shrink-0 text-[color:var(--color-brand)]" aria-hidden />
        <span className="text-sm font-semibold">
          {session ? (personaLabel[session.persona] ?? session.persona) : "Sign in"}
        </span>
        {session?.scope_label && (
          <Badge variant="brand" className="uppercase tracking-wide">
            {session.scope_label}
          </Badge>
        )}
      </div>
      {session && (
        <div className="hidden flex-1 justify-center px-2 sm:flex">
          <NavSearch />
        </div>
      )}
      <div className="flex items-center gap-3">
        {session && (
          <div className="hidden sm:flex flex-col items-end leading-tight text-xs">
            <span className="font-medium text-[color:var(--color-text)]">{session.full_name || session.email}</span>
            <span className="text-[color:var(--color-text-muted)]">{session.email}</span>
          </div>
        )}
        <ThemeToggle />
        {session ? (
          <LogoutButton />
        ) : (
          <Button asChild variant="secondary" size="sm"><a href="/login">Sign in</a></Button>
        )}
      </div>
    </header>
  );
}
