import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    name: "garden-renderer",
    include: ["test/**/*.test.ts*"],
    environment: "node",
  },
});
