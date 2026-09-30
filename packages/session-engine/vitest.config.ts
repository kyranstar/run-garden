import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "session-engine",
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
