import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import SuperAdminCockpit from "./_dashboard/super-admin-cockpit";

export default async function DashboardHome() {
  // Persona-aware landing — PROVIDER/MERCHANT log in and land on their own
  // portal instead of the SUPER_ADMIN operations console.
  const session = await getSession();
  if (session?.persona === "PROVIDER")  redirect("/provider-portal");
  if (session?.persona === "MERCHANT")  redirect("/merchant-portal");
  return <SuperAdminCockpit />;
}
