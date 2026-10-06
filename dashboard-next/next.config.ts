import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const nextConfig: NextConfig = {
  reactStrictMode: false,
};

export default nextConfig;

// Lets `next dev` see the wrangler.jsonc bindings (BACKEND) via
// getCloudflareContext(), so local dev can reach the private backend Worker.
initOpenNextCloudflareForDev();
