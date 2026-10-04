// Server wrapper for one TSP: a bad id is a 404 here; ./view.tsx is the client UI.

import { notFound } from "next/navigation";
import View from "./view";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function TspDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  return <View id={id} />;
}
