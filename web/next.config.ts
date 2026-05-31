import type { NextConfig } from "next";

const cfg: NextConfig = {
  env: {
    // Empty default = same-origin (Next API routes). Override for an
    // external FastAPI backend during dev.
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || "",
  },
  async rewrites() {
    return [
      // Public v1 API (bearer-auth, see lib/keyStore.ts).
      { source: "/v1/:path*", destination: "/api/v1/:path*" },
      // Admin endpoints called by the in-app keys management page.
      { source: "/admin/:path*", destination: "/api/admin/:path*" },
    ];
  },
};

export default cfg;
