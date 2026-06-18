/**
 * Vitest config for the agent web UI. Mirrors the hub's setup — separate from
 * vite.config.ts so the production-bundle base path doesn't co-mingle with test
 * concerns. jsdom is the rendering target; setupFiles extends `expect` with
 * @testing-library/jest-dom matchers and resets fetch / storage mocks per test.
 */
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    restoreMocks: true,
    clearMocks: true,
  },
});
