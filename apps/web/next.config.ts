import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker image (no full node_modules).
  output: "standalone",
};

export default nextConfig;
