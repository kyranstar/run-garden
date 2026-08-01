import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed dev port and no clearScreen so its logs survive.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5180, strictPort: true },
  build: { outDir: "dist", target: "safari15", sourcemap: true },
});
