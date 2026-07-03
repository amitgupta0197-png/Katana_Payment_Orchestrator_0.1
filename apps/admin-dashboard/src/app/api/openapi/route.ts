// GET /api/openapi — the public OpenAPI 3.0 spec for the Katana Pay integration
// API. Served as JSON for Swagger UI (/developers), Postman, codegen, etc.

import { NextResponse } from "next/server";
import { openapiSpec } from "@/lib/openapi";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(openapiSpec, {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
