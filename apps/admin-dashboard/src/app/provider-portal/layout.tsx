// Provider portal shell. Belt-and-braces auth check on top of middleware.
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { ProviderPortalShell } from "./_components/portal-shell";

export default async function ProviderPortalLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login?next=/provider-portal");
  if (session.persona !== "PROVIDER") {
    redirect(session.persona === "SUPER_ADMIN" ? "/" : "/merchant-portal");
  }
  return (
    <ProviderPortalShell scopeLabel={session.scope_label} email={session.email} fullName={session.full_name}>
      {children}
    </ProviderPortalShell>
  );
}
