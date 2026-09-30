import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "database",
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
