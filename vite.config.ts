import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // No environment values are exported to the browser, including VITE_*.
  envPrefix: [],
  publicDir: false,
  build: { outDir: "dist/web", emptyOutDir: true, sourcemap: false },
  server: { host: "127.0.0.1", proxy: { "/api": "http://127.0.0.1:3000" } },
});
