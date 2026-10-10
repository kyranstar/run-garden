import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "workout",
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
