import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

// Two tiers are exposed as separate runnable targets via package.json scripts:
//   pnpm test             -> unit only (tests/unit)
//   pnpm test:integration -> integration only (tests/integration)
// Both tiers share this single config; the scripts pass a directory filter.
// Keeping it as one file is the simplest setup that gives two distinct
// targets — no workspace/projects machinery needed yet.
//
// The `vite-tsconfig-paths` plugin (#49) wires Vite/Vitest to honor the
// `paths` map from `tsconfig.json` — in particular `"@/*": ["./*"]` —
// so test files and the modules they import can use the same `@/…`
// aliases Next.js uses at runtime. Before this plugin, a test that
// pulled in a module which imported `@/lib/tap` would crash at
// resolve-time, and the only workarounds were either mirroring every
// `@/` import as a relative path or hiding the alias-using modules
// behind lazy dynamic imports. Both are gone now.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ['tests/{unit,integration}/**/*.test.ts'],
  },
})
