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
      //
      // Vitest 4 changed how V8 coverage is mapped back to the source (AST
      // based instead of v8-to-istanbul). The same suite now reads statements
      // 98.6, branches 93.4, functions 96.9 and lines 100, so the floors moved
      // with the measurement, not with the tests.
      thresholds: {
        statements: 98,
        branches: 93,
        functions: 96,
        lines: 99,
      },
    },
    testTimeout: 15000,
  },
});
