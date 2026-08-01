import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "coros-bridge",
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
