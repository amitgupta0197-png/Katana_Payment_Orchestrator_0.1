import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    typedRoutes: false,
  },
  // Postgres + gRPC clients are server-only; keep them out of the edge bundle.
  serverExternalPackages: ["pg", "@grpc/grpc-js", "@grpc/proto-loader"],
};

export default nextConfig;
