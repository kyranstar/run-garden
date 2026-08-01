import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "calendar",
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
