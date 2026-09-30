import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "session-engine",
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Many tests build hundreds of whole sessions (the ported standalone loops, the simulation, the swap
    // properties); a build takes a few ms, but a busy machine can stretch a loop past the 5 s default.
    testTimeout: 60_000,
  },
});
