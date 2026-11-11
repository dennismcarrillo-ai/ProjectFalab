import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Tauri espera un puerto fijo para el servidor de desarrollo.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: "127.0.0.1" },
  build: { target: "es2020", chunkSizeWarningLimit: 2000 },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
