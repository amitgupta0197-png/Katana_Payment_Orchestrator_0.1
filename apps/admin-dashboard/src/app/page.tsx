import { redirect } from "next/navigation";
import { LayoutDashboard } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getSession } from "@/lib/auth";

const PILLARS = [
  { title: "Providers",   href: "/providers",   description: "Sub-admin reseller entities & commission rules" },
  { title: "Merchants",   href: "/merchants",   description: "KYB lifecycle, MID/Sub-MID surface" },
  { title: "Sub-MIDs",    href: "/sub-mids",    description: "Traffic-mode → KYC-approved upgrade engine" },
  { title: "Vendors",     href: "/vendors/poolpay", description: "Per-vendor adapter cockpits (PoolPay, Quickpay)" },
  { title: "Partner Data",href: "/partner-data",description: "Pulled UTR / payout-ref / TXID reconciliation" },
  { title: "Reserves",    href: "/reserves",    description: "Rolling-reserve ledger & release schedule" },
  { title: "KYB",         href: "/kyb",         description: "Payments-specific KYB cases & screening" },
  { title: "Risk",        href: "/risk",        description: "Velocity rules, blacklists, chargebacks" },
];

export default async function DashboardHome() {
  // Persona-aware landing — PROVIDER/MERCHANT log in and land on their own
  // portal instead of the SUPER_ADMIN operations console.
  const session = await getSession();
  if (session?.persona === "PROVIDER")  redirect("/provider-portal");
  if (session?.persona === "MERCHANT")  redirect("/merchant-portal");
  return (
    <>
      <PageHeader
        title="Operations console"
        description="Katana super-admin overview. Persona portals at /provider-portal and /merchant-portal."
        icon={LayoutDashboard}
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {PILLARS.map((p) => (
          <a key={p.href} href={p.href} className="block">
            <Card className="h-full transition-shadow hover:shadow-md">
              <CardHeader>
                <CardTitle className="text-base">{p.title}</CardTitle>
                <CardDescription>{p.description}</CardDescription>
              </CardHeader>
              <CardContent>
                <Badge variant="brand">Open</Badge>
              </CardContent>
            </Card>
          </a>
        ))}
      </div>
    </>
  );
}
