// Server wrapper for one workflow instance: a bad id is a 404 here; the client UI is
// components/workflow/instance-view.tsx.

import { notFound } from "next/navigation";
import InstanceView from "@/components/workflow/instance-view";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function JourneyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  return <InstanceView id={id} />;
}
