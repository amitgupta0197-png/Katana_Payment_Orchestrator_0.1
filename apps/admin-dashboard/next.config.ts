import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: false,
  // Postgres + gRPC clients are server-only; keep them out of the edge bundle.
  serverExternalPackages: ["pg", "@grpc/grpc-js", "@grpc/proto-loader"],
  // The agent guide is an HTML page now; links to the old PDF land on it.
  async redirects() {
    return [
      { source: "/Katana-Agent-Guide.pdf", destination: "/katana-agent-guide.html", permanent: false },
      // Merchants were at /providers until 2026-10-03; bankers took /merchants, now /bankers.
      // Old merchant links land on the new URLs; an old banker link /merchants/{id} is sent on
      // by app/merchants/[id]/page.tsx, since the path alone cannot tell the two apart.
      { source: "/providers", destination: "/merchants", permanent: false },
      { source: "/providers/:id", destination: "/merchants/:id", permanent: false },
      { source: "/merchant-portal/merchants", destination: "/merchant-portal/bankers", permanent: false },
      { source: "/merchant-portal/merchants/:id", destination: "/merchant-portal/bankers/:id", permanent: false },
    ];
  },
};

export default nextConfig;
