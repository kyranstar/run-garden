import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "saves-extension",
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
