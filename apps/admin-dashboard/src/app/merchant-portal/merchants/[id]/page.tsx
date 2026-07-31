import { notFound } from "next/navigation";
import { rows } from "@/lib/pg";
import View from "./view";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ProviderPortalMerchantDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  let found = true;
  try {
    const r = await rows<{ id: string }>("merchant",
      "SELECT id FROM merchants WHERE id = $1::uuid LIMIT 1", [id]);
    found = r.length > 0;
  } catch { /* fall through to client */ }
  if (!found) notFound();
  return <View id={id} />;
}
