// Turns what lib/chain-store throws into the routes' answer: `{ error, code, ...extra }`.

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { ChainError } from "@/lib/chain-store";
import { PendingRequestError } from "@/lib/maker-checker";

export function chainErrorResponse(err: unknown): NextResponse {
  if (err instanceof ChainError) return NextResponse.json({ error: err.message, code: err.code, ...err.extra }, { status: err.status });
  if (err instanceof PendingRequestError)
    return NextResponse.json({ error: err.message, code: "REQUEST_PENDING", request_id: err.requestId }, { status: 409 });
  const e = pgError(err);
  return NextResponse.json(e.body, { status: e.status });
}

export async function jsonBody(req: Request): Promise<Record<string, any> | null> {
  try { const b = await req.json(); return b && typeof b === "object" ? b : null; } catch { return null; }
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
