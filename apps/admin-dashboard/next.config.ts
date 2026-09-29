import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    typedRoutes: false,
  },
  // Postgres + gRPC clients are server-only; keep them out of the edge bundle.
  serverExternalPackages: ["pg", "@grpc/grpc-js", "@grpc/proto-loader"],
  // The agent guide is an HTML page now; links to the old PDF land on it.
  async redirects() {
    return [{ source: "/Katana-Agent-Guide.pdf", destination: "/katana-agent-guide.html", permanent: false }];
  },
};

export default nextConfig;
