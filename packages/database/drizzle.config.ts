import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  driver: "d1-http",
  // Individual files (not the ESM barrel): drizzle-kit's CJS loader cannot
  // resolve the .js-suffixed re-exports in index.ts.
  schema: [
    "./src/schema/identity.ts",
    "./src/schema/schedule.ts",
    "./src/schema/activities.ts",
    "./src/schema/garden.ts",
    "./src/schema/product.ts",
    "./src/schema/ops.ts",
    "./src/schema/studio.ts",
    "./src/schema/coach.ts",
  ],
  out: "./migrations",
});
