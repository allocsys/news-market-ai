import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const nextConfig: NextConfig = {
  reactStrictMode: false,
};

export default nextConfig;

// Lets `next dev` see the wrangler.jsonc bindings (DASHBOARD) via
// getCloudflareContext(), so local dev can talk to the real Worker.
initOpenNextCloudflareForDev();
