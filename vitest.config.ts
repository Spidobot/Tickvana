import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/dist/**", "e2e/**"],
    globalSetup: "packages/core/src/testing/global-setup.ts",
    hookTimeout: 180_000,
    testTimeout: 30_000,
    // Every file talks to real databases and some start their own containers.
    // More workers than this and Docker starts timing out on a laptop.
    maxWorkers: 4,
  },
});
