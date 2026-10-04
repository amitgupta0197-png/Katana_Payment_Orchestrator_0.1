"use client";

// Staff: any banker's MID switch, with processor names and the accounts Katana can add.
import { MidSwitchPage } from "@/components/mid-switch/mid-switch-page";

export default function StaffMidSwitchPage() {
  return <MidSwitchPage description="Each banker's pay-in traffic between its own MIDs: processor accounts (Intent) and UPI IDs (P2P), with limits, hours, health, priority or weighted split, and the manual switch." />;
}
