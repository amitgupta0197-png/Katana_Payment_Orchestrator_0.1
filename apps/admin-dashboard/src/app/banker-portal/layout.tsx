// Merchant portal shell. Belt-and-braces auth check on top of middleware.
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { MerchantPortalShell } from "./_components/portal-shell";
import { getLivemode } from "@/lib/mode";

export default async function MerchantPortalLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login?next=/banker-portal");
  if (session.persona !== "MERCHANT") {
    redirect(session.persona === "SUPER_ADMIN" ? "/" : "/merchant-portal");
  }
  return (
    <MerchantPortalShell scopeLabel={session.scope_label} email={session.email} fullName={session.full_name} livemode={await getLivemode()}>
      {children}
    </MerchantPortalShell>
  );
}
