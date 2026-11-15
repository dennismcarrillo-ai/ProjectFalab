import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Tauri espera un puerto fijo para el servidor de desarrollo.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // Al probar en un iPad o en el simulador, Tauri indica en TAURI_DEV_HOST por dónde servir.
  server: { port: 1420, strictPort: true, host: process.env.TAURI_DEV_HOST || "127.0.0.1" },
  build: { target: "es2020", chunkSizeWarningLimit: 2000 },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
