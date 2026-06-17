import { notFound } from "next/navigation";
import { rows } from "@/lib/pg";
import View from "./view";

export default async function CheckoutDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // checkout supports lookup by uuid OR txn_id (text) per the API route.
  let found = true;
  try {
    const r = await rows<{ id: string }>("checkout",
      "SELECT id FROM checkout_orders WHERE id::text = $1 OR txn_id = $1 LIMIT 1", [id]);
    found = r.length > 0;
  } catch { /* fall through to client */ }
  if (!found) notFound();
  return <View id={id} />;
}
