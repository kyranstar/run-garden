import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "coros",
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
