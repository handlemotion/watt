import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      remoteBindings: false,
      miniflare: {
        bindings: {
          CLOUD_DAEMON_TOKEN: "watt-test-cloud-daemon-token",
          CURSOR_API_KEY: "watt-test-cursor-api-key",
          GITHUB_WEBHOOK_SECRET: "watt-test-github-webhook-secret",
          UPSTASH_BOX_API_KEY: "watt-test-upstash-box-api-key",
        },
      },
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
});
