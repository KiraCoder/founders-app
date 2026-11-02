import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PGlite ships WASM + data files; keep it (and the postgres driver) out of the bundler.
  serverExternalPackages: ["@electric-sql/pglite", "postgres"],
  poweredByHeader: false,
  experimental: {
    // People import uploads a spreadsheet (max 2 MB, checked again on the server) through a
    // server action; the default limit is 1 MB.
    serverActions: { bodySizeLimit: "3mb" },
    // The middleware (src/middleware.ts runs for every route) gets a copy of the request
    // body, and Next 15.5 cuts that copy at 10 MiB by default — a document near the 10 MB
    // limit then arrives truncated and fails to parse. 11 MB leaves room for the multipart
    // envelope; anything bigger is refused by the upload route with a 413 (it reads at most
    // 10 MB + 64 KB). Note: Vercel itself refuses request bodies over 4.5 MB (see README).
    middlewareClientMaxBodySize: "11mb",
  },
};

export default nextConfig;
