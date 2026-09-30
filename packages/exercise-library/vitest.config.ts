import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "exercise-library",
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
