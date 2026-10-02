// Every error code the v2 API can answer with is published in the guide, with its HTTP status.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { V2_ERRORS } from "@/lib/v2-api-errors";

const GUIDE = readFileSync(new URL("../../../public/katana-v2-guide.html", import.meta.url), "utf8");

test("the guide lists every v2 error code with the status the API answers", () => {
  for (const [code, e] of Object.entries(V2_ERRORS))
    assert.ok(GUIDE.includes(`<tr><td><code>${code}</code></td><td>${e.status}</td><td>${e.meaning}</td></tr>`), code);
  const listed = [...GUIDE.matchAll(/<tr><td><code>([A-Z_]+)<\/code><\/td><td>\d{3}<\/td>/g)].map((m) => m[1]);
  assert.deepEqual(listed.sort(), Object.keys(V2_ERRORS).sort());
});

import { openapiSpec } from "@/lib/openapi";

test("the OpenAPI spec describes both v2 endpoints, the Bearer key and every error code", () => {
  const paths = openapiSpec.paths as Record<string, any>;
  assert.ok(paths["/v2/orders"].post && paths["/v2/orders/{id}"].get);
  assert.deepEqual(paths["/v2/orders"].post.security, [{ ApiKey: [] }]);
  const schemas = openapiSpec.components.schemas as Record<string, any>;
  assert.deepEqual(schemas.V2Error.properties.code.enum.slice().sort(), Object.keys(V2_ERRORS).sort());
  assert.deepEqual(schemas.V2Order.properties.status.enum, ["PENDING", "SUCCESS", "FAILED", "EXPIRED"]);
  // Each status the API can answer on create is listed with its codes.
  for (const status of new Set(Object.values(V2_ERRORS).map((e) => String(e.status))))
    if (status !== "404") assert.ok(paths["/v2/orders"].post.responses[status], status);
});
