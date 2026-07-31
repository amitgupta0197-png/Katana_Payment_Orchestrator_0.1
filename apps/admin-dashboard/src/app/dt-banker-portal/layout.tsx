// Banker portal shell. Belt-and-braces auth check on top of middleware.
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { BankerPortalShell } from "./_components/portal-shell";

export default async function BankerPortalLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login?next=/dt-banker-portal");
  if (session.persona !== "BANKER") {
    redirect(
      session.persona === "PROVIDER" ? "/merchant-portal"
        : session.persona === "MERCHANT" ? "/banker-portal"
        : "/",
    );
  }
  return (
    <BankerPortalShell scopeLabel={session.scope_label || session.scope_id || "Banker"} email={session.email} fullName={session.full_name}>
      {children}
    </BankerPortalShell>
  );
}
