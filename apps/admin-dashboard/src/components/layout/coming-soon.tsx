import { Construction } from "lucide-react";
import { PageHeader } from "./page-header";
import { Card, CardContent } from "@/components/ui/card";

interface ComingSoonProps {
  title: string;
  description?: string;
}

export function ComingSoon({ title, description }: ComingSoonProps) {
  return (
    <>
      <PageHeader
        title={title}
        description={description ?? "This page is part of a phase that hasn't shipped yet."}
        icon={Construction}
      />
      <Card>
        <CardContent className="py-12 text-center">
          <Construction className="mx-auto h-10 w-10 text-[color:var(--color-text-subtle)]" />
          <p className="mt-3 text-sm text-[color:var(--color-text-muted)]">
            Reconstruction in progress. Refer to <code className="font-mono">docs/PRODUCT_VISION.md</code> §3 for the spec.
          </p>
        </CardContent>
      </Card>
    </>
  );
}
