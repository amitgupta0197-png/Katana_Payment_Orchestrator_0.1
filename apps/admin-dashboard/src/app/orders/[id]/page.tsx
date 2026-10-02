"use client";

// Staff order timeline: the same page a merchant sees, with who made each change and on what evidence.

import { use } from "react";
import { OrderTimelineView } from "@/components/portal/order-desk";

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return <OrderTimelineView id={use(params).id} base="/orders" />;
}
