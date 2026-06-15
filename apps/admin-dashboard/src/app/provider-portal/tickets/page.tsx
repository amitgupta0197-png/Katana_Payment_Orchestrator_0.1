"use client";

import { LifeBuoy } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

// TODO: ticket service not implemented. Render empty-state CTA.

export default function TicketsPage() {
  return (
    <>
      <PageHeader
        title="Support tickets"
        description="Raise issues with Katana operations."
        icon={LifeBuoy}
        actions={<Button onClick={() => toast.info("TODO: ticket service")}>New ticket</Button>}
      />
      <Card>
        <CardHeader>
          <CardTitle>No open tickets</CardTitle>
          <CardDescription>The ticket service hasn't shipped yet. Use Slack #katana-providers in the meantime.</CardDescription>
        </CardHeader>
        <CardContent />
      </Card>
    </>
  );
}
