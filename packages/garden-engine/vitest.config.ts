import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "garden-engine",
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
