"use client";

// Identity & access hub: /admin/users, /admin/roles, /admin/access, /admin/assignments as tabs (?tab=). Each tab is the existing
// page, unchanged; its own URL keeps working (lib/nav navHubs, components/layout/hub-page).

import { HubPage } from "@/components/layout/hub-page";
import AdminUsersPage from "@/app/admin/users/page";
import AdminRolesPage from "@/app/admin/roles/page";
import AdminAccessPage from "@/app/admin/access/page";
import AdminAssignmentsPage from "@/app/admin/assignments/page";

export default function HubIdentityPage() {
  return <HubPage href="/hub/identity" components={{ "users": AdminUsersPage, "roles": AdminRolesPage, "access": AdminAccessPage, "assignments": AdminAssignmentsPage }} />;
}
