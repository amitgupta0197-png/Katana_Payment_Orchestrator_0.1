"use client";

// Staff order search (components/portal/order-desk): any banker's order by id, reference or RRN.

import { OrderSearch } from "@/components/portal/order-desk";

export default function Page() {
  return <OrderSearch base="/orders" />;
}
