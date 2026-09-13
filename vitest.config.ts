import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    projects: [
      { extends: true, test: { name: "app", environment: "node", include: ["tests/app/**/*.test.ts"] } },
      { extends: true, test: { name: "web", environment: "jsdom", include: ["tests/web/**/*.test.tsx"] } },
    ],
  },
});
