import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// No incremental cache / queue bindings: every route is dynamic
// (force-dynamic on the API routes, client-side data fetching elsewhere).
export default defineCloudflareConfig();
