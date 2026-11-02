import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PGlite ships WASM + data files; keep it (and the postgres driver) out of the bundler.
  serverExternalPackages: ["@electric-sql/pglite", "postgres"],
  poweredByHeader: false,
};

export default nextConfig;
