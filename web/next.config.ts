import type { NextConfig } from "next";
const cfg: NextConfig = { env: { NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || "http://localhost:7431" } };
export default cfg;
