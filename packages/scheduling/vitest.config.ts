import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "scheduling",
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
