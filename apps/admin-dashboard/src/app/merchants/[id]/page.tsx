// Server wrapper: hard-404 when the merchant id doesn't exist
// (apps/admin-dashboard/src/app/merchants/[id]/view.tsx is the client UI).

import { notFound } from "next/navigation";
import { rows } from "@/lib/pg";
import View from "./view";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function MerchantDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  let found = true;
  try {
    const r = await rows<{ id: string }>("merchant",
      "SELECT id FROM merchants WHERE id = $1::uuid LIMIT 1", [id]);
    found = r.length > 0;
  } catch { /* surface as client-side error rather than 404 */ }
  if (!found) notFound();
  return <View id={id} />;
}
