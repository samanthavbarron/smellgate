import { defineConfig } from 'vitest/config'

// Two tiers are exposed as separate runnable targets via package.json scripts:
//   pnpm test             -> unit only (tests/unit)
//   pnpm test:integration -> integration only (tests/integration)
// Both tiers share this single config; the scripts pass a directory filter.
// Keeping it as one file is the simplest setup that gives two distinct
// targets — no workspace/projects machinery needed yet.
export default defineConfig({
  test: {
    include: ['tests/{unit,integration}/**/*.test.ts'],
  },
})
