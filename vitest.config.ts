import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          RIPE_ATLAS_API_KEY: "0123456789abcdef0123456789abcdef",
          MCP_AUTH_TOKEN: "test-mcp-token-with-at-least-32-characters",
        },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
