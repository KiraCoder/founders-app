import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PGlite ships WASM + data files; keep it (and the postgres driver) out of the bundler.
  serverExternalPackages: ["@electric-sql/pglite", "postgres"],
  poweredByHeader: false,
  experimental: {
    // People import uploads a spreadsheet (max 2 MB, checked again on the server) through a
    // server action; the default limit is 1 MB.
    serverActions: { bodySizeLimit: "3mb" },
  },
};

export default nextConfig;
