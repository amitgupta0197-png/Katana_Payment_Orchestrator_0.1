"use client";

// Order search (components/portal/order-desk): by order id, own reference or bank reference.

import { OrderSearch } from "@/components/portal/order-desk";

export default function Page() {
  return <OrderSearch base="/merchant-portal/orders" />;
}
