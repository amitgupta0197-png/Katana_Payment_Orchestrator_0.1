// Shared answer for the workflow routes (app/api/workflows): a WorkflowError as { error, code, ...extra }, else pgError.

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { WorkflowError } from "@/lib/workflow-store";
import { PendingRequestError } from "@/lib/maker-checker";

export function workflowError(err: unknown): NextResponse {
  if (err instanceof WorkflowError) return NextResponse.json({ error: err.message, code: err.code, ...err.extra }, { status: err.status });
  if (err instanceof PendingRequestError)
    return NextResponse.json({ error: err.message, code: "REQUEST_PENDING", request_id: err.requestId }, { status: 409 });
  const e = pgError(err);
  return NextResponse.json(e.body, { status: e.status });
}
