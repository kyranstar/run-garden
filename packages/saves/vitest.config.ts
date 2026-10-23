import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "saves",
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
