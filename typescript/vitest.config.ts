import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      include: ["src/**/*.ts"],
      // probe.ts shells out to the operating system it is running on. It
      // cannot be exercised for Windows, macOS and Linux from one machine, and
      // pretending otherwise with mocks would only test the mocks.
      exclude: ["src/**/*.d.ts", "src/types.ts", "src/index.ts", "src/probe.ts"],
      // Raised to just under what the suite actually reaches, so the numbers
      // are a floor rather than a wish. The gap to 100 is `client.ts`'s
      // fallback to the real hardware probe, which is the same thing probe.ts
      // is excluded for: it cannot be exercised for three operating systems
      // from one machine, and a mock would only test the mock.
      thresholds: {
        statements: 99,
        branches: 94,
        functions: 100,
        lines: 99,
      },
    },
    testTimeout: 15000,
  },
});
