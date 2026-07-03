"use client";

// Public developer API reference — renders Swagger UI for the Katana Pay OpenAPI
// spec served at /api/openapi. Swagger UI is loaded from a CDN (no npm dependency).

import { useEffect } from "react";

const SWAGGER_VERSION = "5.17.14";

export default function DevelopersPage() {
  useEffect(() => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = `https://unpkg.com/swagger-ui-dist@${SWAGGER_VERSION}/swagger-ui.css`;
    document.head.appendChild(css);

    const script = document.createElement("script");
    script.src = `https://unpkg.com/swagger-ui-dist@${SWAGGER_VERSION}/swagger-ui-bundle.js`;
    script.crossOrigin = "anonymous";
    script.onload = () => {
      // @ts-expect-error injected global from the CDN bundle
      window.SwaggerUIBundle({
        url: "/api/openapi",
        domNode: document.getElementById("swagger-root"),
        deepLinking: true,
        defaultModelsExpandDepth: 1,
        tryItOutEnabled: false,
      });
    };
    document.body.appendChild(script);

    return () => {
      css.remove();
      script.remove();
    };
  }, []);

  return (
    <div style={{ minHeight: "100vh", background: "#fff" }}>
      <div style={{ background: "#0b1020", color: "#fff", padding: "16px 24px" }}>
        <div style={{ fontWeight: 700, fontSize: 18 }}>Katana Pay — Developer API</div>
        <div style={{ fontSize: 13, opacity: 0.8 }}>
          S2S UPI pay-in integration. Spec: <a href="/api/openapi" style={{ color: "#7aa2ff" }}>/api/openapi</a> · Guide: <a href="https://github.com" style={{ color: "#7aa2ff" }}>S2S-INTEGRATION.md</a>
        </div>
      </div>
      <div id="swagger-root" />
      <noscript style={{ display: "block", padding: 24 }}>
        Enable JavaScript to view the interactive API reference, or fetch the spec at <code>/api/openapi</code>.
      </noscript>
    </div>
  );
}
