// Turns what lib/mdm-store throws into the MDM routes' answer: `{ error, code, ...extra }`.

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { PendingRequestError } from "@/lib/maker-checker";
import { MdmError } from "@/lib/mdm-store";
import { parseMasterType, type MasterType } from "@/lib/mdm";

export function mdmErrorResponse(err: unknown): NextResponse {
  if (err instanceof MdmError) return NextResponse.json({ error: err.message, code: err.code, ...err.extra }, { status: err.status });
  if (err instanceof PendingRequestError)
    return NextResponse.json({ error: err.message, code: "REQUEST_PENDING", request_id: err.requestId }, { status: 409 });
  const e = pgError(err);
  return NextResponse.json(e.body, { status: e.status });
}

/** The master type in a route's path, or a 404 answer. */
export function typeOr404(raw: string): { type: MasterType } | { response: NextResponse } {
  const type = parseMasterType(raw);
  return type ? { type } : { response: NextResponse.json({ error: `unknown master type ${raw}`, code: "UNKNOWN_TYPE" }, { status: 404 }) };
}
