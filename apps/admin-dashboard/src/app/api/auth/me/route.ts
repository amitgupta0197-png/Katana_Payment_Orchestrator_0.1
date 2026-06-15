import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";

export async function GET() {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  return NextResponse.json({
    user: { id: s.user_id, email: s.email, full_name: s.full_name },
    persona: s.persona,
    scope: { id: s.scope_id, label: s.scope_label },
  });
}
