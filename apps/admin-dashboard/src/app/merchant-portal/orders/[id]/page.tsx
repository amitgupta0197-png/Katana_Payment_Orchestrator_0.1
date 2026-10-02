"use client";

// One order's timeline (components/portal/order-desk): status history and webhook deliveries.

import { use } from "react";
import { OrderTimelineView } from "@/components/portal/order-desk";

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return <OrderTimelineView id={use(params).id} base="/merchant-portal/orders" />;
}
